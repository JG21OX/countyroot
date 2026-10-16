//! set_paused tests: run `cargo build-sbf --arch v0` first, then `cargo test`.
use anchor_lang::{prelude::Pubkey, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use base64::Engine;
use countyroot::PauseChanged;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");

struct E { svm: LiteSVM, auth: Keypair, att: Keypair, config: Pubkey }

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> Result<Vec<String>, String> {
    let tx = Transaction::new(&[payer], Message::new(&[ix], Some(&payer.pubkey())), svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|m| m.logs).map_err(|e| format!("{:?}", e.meta.logs));
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

fn cr(fips: u32, epoch: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"county_root", &fips.to_le_bytes(), &epoch.to_le_bytes()], &countyroot::ID).0
}

impl E {
    fn new() -> E {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(countyroot::ID, SO).unwrap();
        let (auth, att) = (Keypair::new(), Keypair::new());
        svm.airdrop(&auth.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&att.pubkey(), 10_000_000_000).unwrap();
        let config = Pubkey::find_program_address(&[b"config"], &countyroot::ID).0;
        let mut e = E { svm, auth, att, config };
        let a = e.auth.insecure_clone();
        e.tx(&a, countyroot::instruction::InitConfig { attestor: e.att.pubkey() }.data(),
            countyroot::accounts::InitConfig { config, payer: a.pubkey(), system_program: Pubkey::default() }.to_account_metas(None)).unwrap();
        e
    }
    fn tx(&mut self, k: &Keypair, data: Vec<u8>, metas: Vec<anchor_lang::prelude::AccountMeta>) -> Result<Vec<String>, String> {
        send(&mut self.svm, k, Instruction::new_with_bytes(countyroot::ID, &data, metas))
    }
    fn set_paused(&mut self, k: &Keypair, paused: bool) -> Result<Vec<String>, String> {
        let c = self.config;
        self.tx(k, countyroot::instruction::SetPaused { paused }.data(),
            countyroot::accounts::SetPaused { config: c, authority: k.pubkey() }.to_account_metas(None))
    }
    fn post(&mut self, fips: u32) -> Result<Vec<String>, String> {
        let (a, c) = (self.att.insecure_clone(), self.config);
        self.tx(&a, countyroot::instruction::PostRoot { fips, epoch: 1, n_parcels: 1, merkle_root: [1u8; 32], schema: [0u8; 32] }.data(),
            countyroot::accounts::PostRoot { config: c, county_root: cr(fips, 1), attestor: a.pubkey(), system_program: Pubkey::default() }.to_account_metas(None))
    }
    fn update(&mut self, fips: u32) -> Result<Vec<String>, String> {
        let (a, c) = (self.att.insecure_clone(), self.config);
        self.tx(&a, countyroot::instruction::UpdateRoot { n_parcels: 2, merkle_root: [2u8; 32], schema: [0u8; 32] }.data(),
            countyroot::accounts::UpdateRoot { config: c, county_root: cr(fips, 1), attestor: a.pubkey() }.to_account_metas(None))
    }
    fn retract(&mut self, fips: u32) -> Result<Vec<String>, String> {
        let (a, c) = (self.att.insecure_clone(), self.config);
        self.tx(&a, countyroot::instruction::RetractRoot {}.data(),
            countyroot::accounts::RetractRoot { config: c, county_root: cr(fips, 1), attestor: a.pubkey() }.to_account_metas(None))
    }
    fn close(&mut self, fips: u32) -> Result<Vec<String>, String> {
        let (a, c) = (self.auth.insecure_clone(), self.config);
        self.tx(&a, countyroot::instruction::CloseRoot {}.data(),
            countyroot::accounts::CloseRoot { config: c, county_root: cr(fips, 1), authority: a.pubkey() }.to_account_metas(None))
    }
    fn paused_flag(&self) -> bool { self.svm.get_account(&self.config).unwrap().data[72] == 1 }
}

fn is_paused_err(r: Result<Vec<String>, String>) { let e = r.unwrap_err(); assert!(e.contains("Paused"), "{e}"); }

#[test]
fn pause_blocks_all_writes_and_unpause_restores() {
    let mut e = E::new();
    e.post(1).unwrap();                 // will be updated
    e.post(2).unwrap(); e.retract(2).unwrap(); // will be closed
    let auth = e.auth.insecure_clone();
    let mut c: solana_clock::Clock = e.svm.get_sysvar();
    c.slot = 777; c.unix_timestamp = 1_760_002_000; e.svm.set_sysvar(&c);

    let ev: PauseChanged = event(&e.set_paused(&auth, true).unwrap());
    assert_eq!((ev.authority, ev.old, ev.new, ev.slot, ev.ts), (auth.pubkey(), false, true, 777, 1_760_002_000));
    assert!(e.paused_flag());
    is_paused_err(e.post(3));
    is_paused_err(e.update(1));
    is_paused_err(e.retract(1));
    is_paused_err(e.close(2));

    // idempotent: pausing again succeeds, old == new
    let ev: PauseChanged = event(&e.set_paused(&auth, true).unwrap());
    assert_eq!((ev.old, ev.new), (true, true));

    let ev: PauseChanged = event(&e.set_paused(&auth, false).unwrap());
    assert_eq!((ev.old, ev.new), (true, false));
    assert!(!e.paused_flag());
    e.post(3).unwrap();
    e.update(1).unwrap();
    e.retract(1).unwrap();
    e.close(2).unwrap();
}

#[test]
fn non_authority_rejected() {
    let mut e = E::new();
    let att = e.att.insecure_clone();
    let err = e.set_paused(&att, true).unwrap_err();
    assert!(err.contains("BadAuthority"), "{err}");
    assert!(!e.paused_flag());
    // also cannot unpause
    let auth = e.auth.insecure_clone();
    e.set_paused(&auth, true).unwrap();
    assert!(e.set_paused(&att, false).unwrap_err().contains("BadAuthority"));
    assert!(e.paused_flag());
}
