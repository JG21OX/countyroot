//! Event tests: run `cargo build-sbf` first, then `cargo test`.
use anchor_lang::{prelude::Pubkey, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use base64::Engine;
use countyroot::{ConfigInitialized, RootPosted, RootRetracted, RootUpdated};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Vec<String> {
    let msg = Message::new(&[ix], Some(&payer.pubkey()));
    let tx = Transaction::new(&[payer], msg, svm.latest_blockhash());
    let meta = svm.send_transaction(tx).expect("tx failed");
    svm.expire_blockhash();
    meta.logs
}

fn event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> T {
    let mut found = vec![];
    for l in logs {
        if let Some(b) = l.strip_prefix("Program data: ") {
            let raw = base64::engine::general_purpose::STANDARD.decode(b).unwrap();
            if raw.starts_with(T::DISCRIMINATOR) {
                found.push(T::deserialize(&mut &raw[T::DISCRIMINATOR.len()..]).unwrap());
            }
        }
    }
    assert_eq!(found.len(), 1, "expected exactly one event, logs: {logs:?}");
    found.pop().unwrap()
}

fn set_clock(svm: &mut LiteSVM, slot: u64, ts: i64) {
    let mut c: solana_clock::Clock = svm.get_sysvar();
    c.slot = slot;
    c.unix_timestamp = ts;
    svm.set_sysvar(&c);
}

#[test]
fn emits_all_events() {
    let pid = countyroot::ID;
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(pid, SO).unwrap();
    let auth = Keypair::new();
    let att = Keypair::new();
    svm.airdrop(&auth.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&att.pubkey(), 10_000_000_000).unwrap();
    let sys = Pubkey::default();
    let (config, _) = Pubkey::find_program_address(&[b"config"], &pid);

    // init_config
    let ix = Instruction::new_with_bytes(
        pid,
        &countyroot::instruction::InitConfig { attestor: att.pubkey() }.data(),
        countyroot::accounts::InitConfig { config, payer: auth.pubkey(), system_program: sys }
            .to_account_metas(None),
    );
    let e: ConfigInitialized = event(&send(&mut svm, &auth, ix));
    assert_eq!(e.authority, auth.pubkey());
    assert_eq!(e.attestor, att.pubkey());

    // post_root
    let (fips, epoch) = (6037u32, 2u32);
    let (cr, _) = Pubkey::find_program_address(
        &[b"county_root", &fips.to_le_bytes(), &epoch.to_le_bytes()], &pid);
    set_clock(&mut svm, 1000, 1_760_000_000);
    let ix = Instruction::new_with_bytes(
        pid,
        &countyroot::instruction::PostRoot {
            fips, epoch, n_parcels: 42, merkle_root: [7u8; 32], schema: [1u8; 32],
        }.data(),
        countyroot::accounts::PostRoot { config, county_root: cr, attestor: att.pubkey(), system_program: sys }
            .to_account_metas(None),
    );
    let e: RootPosted = event(&send(&mut svm, &att, ix));
    assert_eq!((e.county_root, e.fips, e.epoch, e.n_parcels), (cr, fips, epoch, 42));
    assert_eq!((e.merkle_root, e.schema), ([7u8; 32], [1u8; 32]));
    assert_eq!((e.attestor, e.slot, e.ts, e.version), (att.pubkey(), 1000, 1_760_000_000, countyroot::COUNTY_ROOT_VERSION));

    // update_root
    set_clock(&mut svm, 2000, 1_760_000_100);
    let ix = Instruction::new_with_bytes(
        pid,
        &countyroot::instruction::UpdateRoot { n_parcels: 43, merkle_root: [8u8; 32], schema: [2u8; 32] }.data(),
        countyroot::accounts::UpdateRoot { config, county_root: cr, attestor: att.pubkey() }
            .to_account_metas(None),
    );
    let e: RootUpdated = event(&send(&mut svm, &att, ix));
    assert_eq!((e.county_root, e.fips, e.epoch), (cr, fips, epoch));
    assert_eq!((e.old_n_parcels, e.new_n_parcels), (42, 43));
    assert_eq!((e.old_root, e.new_root), ([7u8; 32], [8u8; 32]));
    assert_eq!((e.old_schema, e.new_schema), ([1u8; 32], [2u8; 32]));
    assert_eq!((e.attestor, e.slot, e.ts, e.version), (att.pubkey(), 2000, 1_760_000_100, countyroot::COUNTY_ROOT_VERSION));

    // retract_root
    set_clock(&mut svm, 3000, 1_760_000_200);
    let ix = Instruction::new_with_bytes(
        pid,
        &countyroot::instruction::RetractRoot {}.data(),
        countyroot::accounts::RetractRoot { config, county_root: cr, attestor: att.pubkey() }
            .to_account_metas(None),
    );
    let e: RootRetracted = event(&send(&mut svm, &att, ix));
    assert_eq!((e.county_root, e.fips, e.epoch, e.merkle_root), (cr, fips, epoch, [8u8; 32]));
    assert_eq!(e.prev_status, countyroot::STATUS_ACTIVE);
    assert_eq!((e.attestor, e.slot, e.ts, e.version), (att.pubkey(), 3000, 1_760_000_200, countyroot::COUNTY_ROOT_VERSION));

    // new posts are v1 (99 bytes); Config unchanged at 74
    assert_eq!(svm.get_account(&cr).unwrap().data.len(), countyroot::COUNTY_ROOT_V1_LEN);
    assert_eq!(svm.get_account(&config).unwrap().data.len(), 8 + 32 + 32 + 1 + 1);
}
