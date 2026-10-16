//! close_root tests: run `cargo build-sbf --arch v0` first, then `cargo test`.
use anchor_lang::{prelude::Pubkey, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use base64::Engine;
use countyroot::RootClosed;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");
const FIPS: u32 = 6037;
const EPOCH: u32 = 2;

struct Env { svm: LiteSVM, auth: Keypair, att: Keypair, config: Pubkey, cr: Pubkey }

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<Vec<String>, String> {
    let msg = Message::new(&[ix], Some(&payer.pubkey()));
    let tx = Transaction::new(&[payer], msg, svm.latest_blockhash());
    let r = svm.send_transaction(tx);
    svm.expire_blockhash();
    r.map(|m| m.logs).map_err(|e| format!("{:?}", e.meta.logs))
}

fn setup(retract: bool) -> Env {
    let pid = countyroot::ID;
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(pid, SO).unwrap();
    let (auth, att) = (Keypair::new(), Keypair::new());
    svm.airdrop(&auth.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&att.pubkey(), 10_000_000_000).unwrap();
    let sys = Pubkey::default();
    let (config, _) = Pubkey::find_program_address(&[b"config"], &pid);
    let (cr, _) = Pubkey::find_program_address(
        &[b"county_root", &FIPS.to_le_bytes(), &EPOCH.to_le_bytes()], &pid);
    send(&mut svm, &auth, Instruction::new_with_bytes(pid,
        &countyroot::instruction::InitConfig { attestor: att.pubkey() }.data(),
        countyroot::accounts::InitConfig { config, payer: auth.pubkey(), system_program: sys }.to_account_metas(None))).unwrap();
    send(&mut svm, &att, Instruction::new_with_bytes(pid,
        &countyroot::instruction::PostRoot { fips: FIPS, epoch: EPOCH, n_parcels: 42, merkle_root: [7u8; 32], schema: [1u8; 32] }.data(),
        countyroot::accounts::PostRoot { config, county_root: cr, attestor: att.pubkey(), system_program: sys }.to_account_metas(None))).unwrap();
    if retract {
        send(&mut svm, &att, Instruction::new_with_bytes(pid,
            &countyroot::instruction::RetractRoot {}.data(),
            countyroot::accounts::RetractRoot { config, county_root: cr, attestor: att.pubkey() }.to_account_metas(None))).unwrap();
    }
    Env { svm, auth, att, config, cr }
}

fn close_ix(e: &Env, authority: Pubkey) -> Instruction {
    Instruction::new_with_bytes(countyroot::ID, &countyroot::instruction::CloseRoot {}.data(),
        countyroot::accounts::CloseRoot { config: e.config, county_root: e.cr, authority }.to_account_metas(None))
}

fn event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> T {
    let evs: Vec<T> = logs.iter().filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap())
        .filter(|r| r.starts_with(T::DISCRIMINATOR))
        .map(|r| T::deserialize(&mut &r[T::DISCRIMINATOR.len()..]).unwrap()).collect();
    assert_eq!(evs.len(), 1);
    evs.into_iter().next().unwrap()
}

#[test]
fn close_after_retract_returns_rent_and_emits() {
    let mut e = setup(true);
    let rent = e.svm.get_account(&e.cr).unwrap().lamports;
    let before = e.svm.get_balance(&e.auth.pubkey()).unwrap();
    let mut c: solana_clock::Clock = e.svm.get_sysvar();
    c.slot = 4242; c.unix_timestamp = 1_760_001_000;
    e.svm.set_sysvar(&c);
    let ix = close_ix(&e, e.auth.pubkey());
    let auth = e.auth.insecure_clone();
    let logs = send(&mut e.svm, &auth, ix).unwrap();
    let after = e.svm.get_balance(&e.auth.pubkey()).unwrap();
    assert_eq!(after, before + rent - 5000, "rent minus 1 signature fee");
    assert!(e.svm.get_account(&e.cr).map_or(true, |a| a.lamports == 0 && a.data.is_empty()));
    let ev: RootClosed = event(&logs);
    assert_eq!((ev.county_root, ev.fips, ev.epoch, ev.merkle_root), (e.cr, FIPS, EPOCH, [7u8; 32]));
    assert_eq!((ev.authority, ev.lamports_returned), (e.auth.pubkey(), rent));
    assert_eq!((ev.slot, ev.ts), (4242, 1_760_001_000));
}

#[test]
fn close_active_root_fails() {
    let mut e = setup(false);
    let (ix, auth) = (close_ix(&e, e.auth.pubkey()), e.auth.insecure_clone());
    let err = send(&mut e.svm, &auth, ix).unwrap_err();
    assert!(err.contains("NotRetracted"), "{err}");
    assert!(e.svm.get_account(&e.cr).unwrap().lamports > 0);
}

#[test]
fn non_authority_fails() {
    let mut e = setup(true);
    // the attestor is not the authority
    let (ix, att) = (close_ix(&e, e.att.pubkey()), e.att.insecure_clone());
    let err = send(&mut e.svm, &att, ix).unwrap_err();
    assert!(err.contains("BadAuthority"), "{err}");
    assert!(e.svm.get_account(&e.cr).unwrap().lamports > 0);
}

#[test]
fn paused_fails() {
    let mut e = setup(true);
    let auth = e.auth.insecure_clone();
    let ix = Instruction::new_with_bytes(countyroot::ID, &countyroot::instruction::SetPaused { paused: true }.data(),
        countyroot::accounts::SetPaused { config: e.config, authority: auth.pubkey() }.to_account_metas(None));
    send(&mut e.svm, &auth, ix).unwrap();
    let (ix, auth) = (close_ix(&e, e.auth.pubkey()), e.auth.insecure_clone());
    let err = send(&mut e.svm, &auth, ix).unwrap_err();
    assert!(err.contains("Paused"), "{err}");
}

#[test]
fn repost_after_close_recreates_pda() {
    // Documents current behaviour: once closed, post_root can re-create the same fips/epoch PDA.
    let mut e = setup(true);
    let (ix, auth) = (close_ix(&e, e.auth.pubkey()), e.auth.insecure_clone());
    send(&mut e.svm, &auth, ix).unwrap();
    let att = e.att.insecure_clone();
    let ix = Instruction::new_with_bytes(countyroot::ID,
        &countyroot::instruction::PostRoot { fips: FIPS, epoch: EPOCH, n_parcels: 1, merkle_root: [9u8; 32], schema: [1u8; 32] }.data(),
        countyroot::accounts::PostRoot { config: e.config, county_root: e.cr, attestor: att.pubkey(), system_program: Pubkey::default() }.to_account_metas(None));
    assert!(send(&mut e.svm, &att, ix).is_ok());
}
