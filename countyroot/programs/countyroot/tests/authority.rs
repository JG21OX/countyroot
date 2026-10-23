//! Two-step config authority rotation. Build first:
//!   cargo build-sbf --arch v0   (here and in test-programs/cpi_signer)
mod common;
use anchor_lang::{prelude::{AccountMeta, Pubkey}, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use base64::Engine;
use countyroot::{AuthorityChanged, AuthorityProposalCancelled, AuthorityProposed};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");
const CPI_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-programs/cpi_signer/target/deploy/cpi_signer.so");
type R = Result<Vec<String>, String>;

fn event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> T {
    let evs: Vec<T> = logs.iter().filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap())
        .filter(|r| r.starts_with(T::DISCRIMINATOR))
        .map(|r| T::deserialize(&mut &r[T::DISCRIMINATOR.len()..]).unwrap()).collect();
    assert_eq!(evs.len(), 1);
    evs.into_iter().next().unwrap()
}

struct E { svm: LiteSVM, auth: Keypair, att: Keypair, config: Pubkey, pending: Pubkey }

impl E {
    fn new() -> E {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(countyroot::ID, SO).unwrap();
        let (auth, att) = (Keypair::new(), Keypair::new());
        svm.airdrop(&auth.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&att.pubkey(), 10_000_000_000).unwrap();
        let config = Pubkey::find_program_address(&[b"config"], &countyroot::ID).0;
        let pending = Pubkey::find_program_address(&[b"pending_authority"], &countyroot::ID).0;
        let mut e = E { svm, auth, att, config, pending };
        let a = e.auth.insecure_clone();
        e.tx(&a, countyroot::instruction::InitConfig { attestor: e.att.pubkey() }.data(),
            countyroot::accounts::InitConfig { config, payer: a.pubkey(), system_program: Pubkey::default() }.to_account_metas(None)).unwrap();
        e
    }
    fn send_ix(&mut self, k: &Keypair, ix: Instruction) -> R {
        let tx = Transaction::new(&[k], Message::new(&[ix], Some(&k.pubkey())), self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx).map(|m| m.logs).map_err(|e| format!("{:?}", e.meta.logs));
        self.svm.expire_blockhash();
        r
    }
    fn tx(&mut self, k: &Keypair, data: Vec<u8>, metas: Vec<AccountMeta>) -> R {
        self.send_ix(k, Instruction::new_with_bytes(countyroot::ID, &data, metas))
    }
    fn propose(&mut self, k: &Keypair, new_authority: Pubkey) -> R {
        let (c, p) = (self.config, self.pending);
        self.tx(k, countyroot::instruction::ProposeAuthority { new_authority }.data(),
            countyroot::accounts::ProposeAuthority { config: c, pending: p, authority: k.pubkey(), system_program: Pubkey::default() }.to_account_metas(None))
    }
    fn accept_metas(&self, proposer: Pubkey, new_authority: Pubkey) -> Vec<AccountMeta> {
        countyroot::accounts::AcceptAuthority { config: self.config, pending: self.pending, proposer, new_authority }.to_account_metas(None)
    }
    fn accept(&mut self, k: &Keypair, proposer: Pubkey) -> R {
        let m = self.accept_metas(proposer, k.pubkey());
        self.tx(k, countyroot::instruction::AcceptAuthority {}.data(), m)
    }
    fn cancel(&mut self, k: &Keypair, proposer: Pubkey) -> R {
        let (c, p) = (self.config, self.pending);
        self.tx(k, countyroot::instruction::CancelAuthority {}.data(),
            countyroot::accounts::CancelAuthority { config: c, pending: p, proposer, authority: k.pubkey() }.to_account_metas(None))
    }
    fn set_paused(&mut self, k: &Keypair, paused: bool) -> R {
        let c = self.config;
        self.tx(k, countyroot::instruction::SetPaused { paused }.data(),
            countyroot::accounts::SetPaused { config: c, authority: k.pubkey() }.to_account_metas(None))
    }
    fn set_attestor(&mut self, k: &Keypair, new_attestor: Pubkey) -> R {
        let c = self.config;
        self.tx(k, countyroot::instruction::SetAttestor { new_attestor }.data(),
            countyroot::accounts::SetAttestor { config: c, authority: k.pubkey() }.to_account_metas(None))
    }
    fn cr(fips: u32) -> Pubkey {
        Pubkey::find_program_address(&[b"county_root", &fips.to_le_bytes(), &1u32.to_le_bytes()], &countyroot::ID).0
    }
    fn post_and_retract(&mut self, fips: u32) {
        let a = self.att.insecure_clone();
        let (d, m) = common::post_v2(a.pubkey(), 1000 + fips, 1, None, [1u8; 32], common::prov(1));
        self.tx(&a, d, m).unwrap();
        let (d, m) = common::retract_v2(a.pubkey(), 1000 + fips, 1, countyroot::REASON_OTHER);
        self.tx(&a, d, m).unwrap();
    }
    fn close(&mut self, k: &Keypair, fips: u32) -> R {
        let (d, m) = common::close(k.pubkey(), 1000 + fips, 1);
        self.tx(k, d, m)
    }
    fn authority(&self) -> Pubkey { Pubkey::try_from(&self.svm.get_account(&self.config).unwrap().data[8..40]).unwrap() }
    fn pending_exists(&self) -> bool { self.svm.get_account(&self.pending).map_or(false, |a| a.lamports > 0) }
}

fn err_has(r: R, s: &str) { let e = r.unwrap_err(); assert!(e.contains(s), "want {s}: {e}"); }

#[test]
fn propose_accept_moves_all_powers() {
    let mut e = E::new();
    let (old, new) = (e.auth.insecure_clone(), Keypair::new());
    e.svm.airdrop(&new.pubkey(), 1_000_000_000).unwrap();
    e.post_and_retract(1);
    e.post_and_retract(2);

    let ev: AuthorityProposed = event(&e.propose(&old, new.pubkey()).unwrap());
    assert_eq!((ev.authority, ev.proposed), (old.pubkey(), new.pubkey()));
    assert!(e.pending_exists());
    assert_eq!(e.authority(), old.pubkey(), "propose alone changes nothing");

    let rent = e.svm.get_account(&e.pending).unwrap().lamports;
    let before = e.svm.get_balance(&old.pubkey()).unwrap();
    let ev: AuthorityChanged = event(&e.accept(&new, old.pubkey()).unwrap());
    assert_eq!((ev.old, ev.new), (old.pubkey(), new.pubkey()));
    assert_eq!(e.authority(), new.pubkey());
    assert!(!e.pending_exists());
    assert_eq!(e.svm.get_balance(&old.pubkey()).unwrap(), before + rent, "rent back to proposer");

    err_has(e.set_paused(&old, true), "BadAuthority");
    err_has(e.set_attestor(&old, Keypair::new().pubkey()), "BadAuthority");
    err_has(e.close(&old, 1), "BadAuthority");
    err_has(e.propose(&old, old.pubkey()), "BadAuthority");

    e.set_paused(&new, true).unwrap();
    e.set_paused(&new, false).unwrap();
    e.close(&new, 1).unwrap();
    e.set_attestor(&new, Keypair::new().pubkey()).unwrap();
}

#[test]
fn wrong_signer_cannot_accept() {
    let mut e = E::new();
    let (old, new, rogue) = (e.auth.insecure_clone(), Keypair::new(), Keypair::new());
    e.svm.airdrop(&rogue.pubkey(), 1_000_000_000).unwrap();
    e.propose(&old, new.pubkey()).unwrap();
    err_has(e.accept(&rogue, old.pubkey()), "WrongPendingAuthority");
    // the old authority can't accept on the new key's behalf either
    err_has(e.accept(&old, old.pubkey()), "WrongPendingAuthority");
    // wrong rent destination is rejected
    e.svm.airdrop(&new.pubkey(), 1_000_000_000).unwrap();
    err_has(e.accept(&new, rogue.pubkey()), "ConstraintHasOne");
    assert_eq!(e.authority(), old.pubkey());
    assert!(e.pending_exists());
}

#[test]
fn cancel_closes_pending() {
    let mut e = E::new();
    let (old, new) = (e.auth.insecure_clone(), Keypair::new());
    e.propose(&old, new.pubkey()).unwrap();
    let att = e.att.insecure_clone();
    err_has(e.cancel(&att, old.pubkey()), "BadAuthority");
    let ev: AuthorityProposalCancelled = event(&e.cancel(&old, old.pubkey()).unwrap());
    assert_eq!((ev.authority, ev.proposed), (old.pubkey(), new.pubkey()));
    assert!(!e.pending_exists());
    e.svm.airdrop(&new.pubkey(), 1_000_000_000).unwrap();
    assert!(e.accept(&new, old.pubkey()).is_err());
    assert_eq!(e.authority(), old.pubkey());
}

#[test]
fn repropose_overwrites() {
    let mut e = E::new();
    let (old, a, b) = (e.auth.insecure_clone(), Keypair::new(), Keypair::new());
    e.svm.airdrop(&a.pubkey(), 1_000_000_000).unwrap();
    e.svm.airdrop(&b.pubkey(), 1_000_000_000).unwrap();
    e.propose(&old, a.pubkey()).unwrap();
    e.propose(&old, b.pubkey()).unwrap();
    err_has(e.accept(&a, old.pubkey()), "WrongPendingAuthority");
    e.accept(&b, old.pubkey()).unwrap();
    assert_eq!(e.authority(), b.pubkey());
}

#[test]
fn zero_and_self_rejected() {
    let mut e = E::new();
    let old = e.auth.insecure_clone();
    err_has(e.propose(&old, Pubkey::default()), "ZeroAuthority");
    err_has(e.propose(&old, old.pubkey()), "SameAuthority");
    let att = e.att.insecure_clone();
    err_has(e.propose(&att, Keypair::new().pubkey()), "BadAuthority");
    assert!(!e.pending_exists());
}

#[test]
fn all_three_work_while_paused() {
    let mut e = E::new();
    let (old, a, b) = (e.auth.insecure_clone(), Keypair::new(), Keypair::new());
    e.svm.airdrop(&b.pubkey(), 1_000_000_000).unwrap();
    e.set_paused(&old, true).unwrap();
    e.propose(&old, a.pubkey()).unwrap();
    e.cancel(&old, old.pubkey()).unwrap();
    e.propose(&old, b.pubkey()).unwrap();
    e.accept(&b, old.pubkey()).unwrap();
    assert_eq!(e.authority(), b.pubkey());
    e.set_paused(&b, false).unwrap();
}

#[test]
fn accept_by_pda_via_cpi_like_squads_vault() {
    let mut e = E::new();
    let cpi = Pubkey::new_unique();
    e.svm.add_program_from_file(cpi, CPI_SO).unwrap();
    let vault = Pubkey::find_program_address(&[b"vault"], &cpi).0; // stands in for a Squads vault PDA
    let old = e.auth.insecure_clone();
    e.propose(&old, vault).unwrap();

    // The outer tx is signed only by a fee payer; the vault "signs" via invoke_signed.
    let payer = Keypair::new();
    e.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut metas = vec![AccountMeta::new_readonly(countyroot::ID, false)];
    metas.extend(e.accept_metas(old.pubkey(), vault).into_iter().map(|mut m| { m.is_signer = false; m }));
    let ix = Instruction::new_with_bytes(cpi, &countyroot::instruction::AcceptAuthority {}.data(), metas);
    let ev: AuthorityChanged = event(&e.send_ix(&payer, ix).unwrap());
    assert_eq!((ev.old, ev.new), (old.pubkey(), vault));
    assert_eq!(e.authority(), vault);
    // And the vault (via CPI) can then use authority powers, e.g. pause.
    let mut metas = vec![AccountMeta::new_readonly(countyroot::ID, false)];
    metas.extend(countyroot::accounts::SetPaused { config: e.config, authority: vault }.to_account_metas(None)
        .into_iter().map(|mut m| { m.is_signer = false; m }));
    let ix = Instruction::new_with_bytes(cpi, &countyroot::instruction::SetPaused { paused: true }.data(), metas);
    e.send_ix(&payer, ix).unwrap();
    assert_eq!(e.svm.get_account(&e.config).unwrap().data[72], 1);
}
