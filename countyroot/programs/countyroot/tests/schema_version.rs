//! Schema-version tests: legacy (v0, 98-byte) accounts keep working; new posts are v1.
use anchor_lang::{prelude::Pubkey, AccountSerialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use base64::Engine;
use countyroot::{CountyRoot, RootClosed, RootRetracted, RootUpdated, COUNTY_ROOT_V0_LEN, COUNTY_ROOT_V1_LEN, COUNTY_ROOT_VERSION, STATUS_ACTIVE};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");
const FIPS: u32 = 48453;
const EPOCH: u32 = 1;

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Vec<String> {
    let tx = Transaction::new(&[payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|m| m.logs).map_err(|e| e.meta.logs).expect("tx failed");
    svm.expire_blockhash();
    r
}

fn event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> T {
    let evs: Vec<T> = logs.iter().filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap())
        .filter(|r| r.starts_with(T::DISCRIMINATOR))
        .map(|r| T::deserialize(&mut &r[T::DISCRIMINATOR.len()..]).unwrap()).collect();
    assert_eq!(evs.len(), 1);
    evs.into_iter().next().unwrap()
}

fn setup() -> (LiteSVM, Keypair, Keypair, Pubkey) {
    let pid = countyroot::ID;
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(pid, SO).unwrap();
    let (auth, att) = (Keypair::new(), Keypair::new());
    svm.airdrop(&auth.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&att.pubkey(), 10_000_000_000).unwrap();
    let (config, _) = Pubkey::find_program_address(&[b"config"], &pid);
    send(&mut svm, &auth, Instruction::new_with_bytes(pid,
        &countyroot::instruction::InitConfig { attestor: att.pubkey() }.data(),
        countyroot::accounts::InitConfig { config, payer: auth.pubkey(), system_program: Pubkey::default() }.to_account_metas(None)));
    (svm, auth, att, config)
}

#[test]
fn legacy_v0_account_update_retract_close() {
    let (mut svm, auth, att, config) = setup();
    let pid = countyroot::ID;
    let (cr, bump) = Pubkey::find_program_address(&[b"county_root", &FIPS.to_le_bytes(), &EPOCH.to_le_bytes()], &pid);
    // Write a raw legacy (pre-version) 98-byte account, exactly as on Devnet today.
    let legacy = CountyRoot { fips: FIPS, epoch: EPOCH, n_parcels: 10, merkle_root: [3u8; 32], schema: [4u8; 32],
        status: STATUS_ACTIVE, posted_at: 1, bump };
    let mut data = vec![];
    legacy.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), COUNTY_ROOT_V0_LEN);
    let lamports = svm.minimum_balance_for_rent_exemption(COUNTY_ROOT_V0_LEN);
    svm.set_account(cr, Account { lamports, data, owner: pid, executable: false, rent_epoch: 0 }).unwrap();

    let e: RootUpdated = event(&send(&mut svm, &att, Instruction::new_with_bytes(pid,
        &countyroot::instruction::UpdateRoot { n_parcels: 11, merkle_root: [5u8; 32], schema: [6u8; 32] }.data(),
        countyroot::accounts::UpdateRoot { config, county_root: cr, attestor: att.pubkey() }.to_account_metas(None))));
    assert_eq!((e.old_root, e.new_root, e.version), ([3u8; 32], [5u8; 32], 0));
    let acc = svm.get_account(&cr).unwrap();
    assert_eq!(acc.data.len(), COUNTY_ROOT_V0_LEN, "update must not resize legacy accounts");
    let got = CountyRoot::deserialize(&mut &acc.data[8..]).unwrap();
    assert_eq!((got.n_parcels, got.merkle_root), (11, [5u8; 32]));

    let e: RootRetracted = event(&send(&mut svm, &att, Instruction::new_with_bytes(pid,
        &countyroot::instruction::RetractRoot {}.data(),
        countyroot::accounts::RetractRoot { config, county_root: cr, attestor: att.pubkey() }.to_account_metas(None))));
    assert_eq!(e.version, 0);

    let e: RootClosed = event(&send(&mut svm, &auth, Instruction::new_with_bytes(pid,
        &countyroot::instruction::CloseRoot {}.data(),
        countyroot::accounts::CloseRoot { config, county_root: cr, authority: auth.pubkey() }.to_account_metas(None))));
    assert_eq!((e.version, e.lamports_returned), (0, lamports));
    assert!(svm.get_account(&cr).map_or(true, |a| a.lamports == 0));
}

#[test]
fn new_post_writes_current_version() {
    let (mut svm, _auth, att, config) = setup();
    let pid = countyroot::ID;
    let (cr, _) = Pubkey::find_program_address(&[b"county_root", &FIPS.to_le_bytes(), &EPOCH.to_le_bytes()], &pid);
    let e: countyroot::RootPosted = event(&send(&mut svm, &att, Instruction::new_with_bytes(pid,
        &countyroot::instruction::PostRoot { fips: FIPS, epoch: EPOCH, n_parcels: 1, merkle_root: [1u8; 32], schema: [0u8; 32] }.data(),
        countyroot::accounts::PostRoot { config, county_root: cr, attestor: att.pubkey(), system_program: Pubkey::default() }.to_account_metas(None))));
    assert_eq!(e.version, COUNTY_ROOT_VERSION);
    let acc = svm.get_account(&cr).unwrap();
    assert_eq!(acc.data.len(), COUNTY_ROOT_V1_LEN);
    assert_eq!(acc.data[COUNTY_ROOT_V0_LEN], COUNTY_ROOT_VERSION);
    // v1 body still decodes with the unchanged struct
    assert_eq!(CountyRoot::deserialize(&mut &acc.data[8..]).unwrap().n_parcels, 1);
    // version byte survives an update (Anchor re-serializes only the 98-byte body)
    let e: RootUpdated = event(&send(&mut svm, &att, Instruction::new_with_bytes(pid,
        &countyroot::instruction::UpdateRoot { n_parcels: 2, merkle_root: [2u8; 32], schema: [0u8; 32] }.data(),
        countyroot::accounts::UpdateRoot { config, county_root: cr, attestor: att.pubkey() }.to_account_metas(None))));
    assert_eq!(e.version, COUNTY_ROOT_VERSION);
    assert_eq!(svm.get_account(&cr).unwrap().data[COUNTY_ROOT_V0_LEN], COUNTY_ROOT_VERSION);
}
