//! init_config upgrade-authority guard: run `cargo build-sbf --arch v0` first, then `cargo test`.
mod common;
use anchor_lang::{prelude::{AccountMeta, Pubkey}, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");

fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(countyroot::ID, SO).unwrap();
    svm
}

fn init(svm: &mut LiteSVM, payer: &Keypair, program_data: Pubkey) -> Result<(), String> {
    let metas: Vec<AccountMeta> = countyroot::accounts::InitConfig {
        config: common::config(), payer: payer.pubkey(), program: countyroot::ID,
        program_data, system_program: Pubkey::default(),
    }.to_account_metas(None);
    let ix = Instruction::new_with_bytes(countyroot::ID,
        &countyroot::instruction::InitConfig { attestor: Keypair::new().pubkey() }.data(), metas);
    let tx = Transaction::new(&[payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.meta.logs));
    svm.expire_blockhash();
    r
}

fn funded(svm: &mut LiteSVM) -> Keypair { let k = Keypair::new(); svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap(); k }

#[test]
fn non_upgrade_authority_is_rejected() {
    let mut s = svm();
    let (owner, attacker) = (funded(&mut s), funded(&mut s));
    common::set_upgrade_authority(&mut s, Some(owner.pubkey()));
    let e = init(&mut s, &attacker, common::program_data()).unwrap_err();
    assert!(e.contains("NotUpgradeAuthority"), "{e}");
    assert!(s.get_account(&common::config()).map_or(true, |a| a.data.is_empty()));
    // the real upgrade authority can still initialize afterwards
    init(&mut s, &owner, common::program_data()).unwrap();
}

#[test]
fn upgrade_authority_succeeds_and_becomes_config_authority() {
    let mut s = svm();
    let owner = funded(&mut s);
    common::set_upgrade_authority(&mut s, Some(owner.pubkey()));
    init(&mut s, &owner, common::program_data()).unwrap();
    let acc = s.get_account(&common::config()).unwrap();
    assert_eq!(acc.data.len(), 8 + 32 + 32 + 1 + 1); // layout unchanged
    assert_eq!(&acc.data[8..40], owner.pubkey().as_ref());
}

#[test]
fn immutable_program_cannot_be_initialized() {
    let mut s = svm();
    let k = funded(&mut s);
    common::set_upgrade_authority(&mut s, None);
    let e = init(&mut s, &k, common::program_data()).unwrap_err();
    assert!(e.contains("NotUpgradeAuthority"), "{e}");
}

#[test]
fn wrong_program_data_account_is_rejected() {
    let mut s = svm();
    let k = funded(&mut s);
    common::set_upgrade_authority(&mut s, Some(k.pubkey()));
    // a ProgramData-shaped account the attacker controls is not accepted
    let mut fake = s.get_account(&common::program_data()).unwrap();
    fake.data[13..45].copy_from_slice(k.pubkey().as_ref());
    let fake_key = Pubkey::new_unique();
    s.set_account(fake_key, fake).unwrap();
    assert!(init(&mut s, &k, fake_key).is_err());
}
