//! set_attestor tests: run `cargo build-sbf --arch v0` first, then `cargo test`.
use anchor_lang::{prelude::{AccountMeta, Pubkey}, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas};
use base64::Engine;
use countyroot::AttestorChanged;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;

const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");
type R = Result<Vec<String>, String>;

struct E { svm: LiteSVM, auth: Keypair, config: Pubkey }

fn cr(fips: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"county_root", &fips.to_le_bytes(), &1u32.to_le_bytes()], &countyroot::ID).0
}

fn event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> T {
    let evs: Vec<T> = logs.iter().filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap())
        .filter(|r| r.starts_with(T::DISCRIMINATOR))
        .map(|r| T::deserialize(&mut &r[T::DISCRIMINATOR.len()..]).unwrap()).collect();
    assert_eq!(evs.len(), 1);
    evs.into_iter().next().unwrap()
}

impl E {
    fn new(att: &Keypair) -> E {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(countyroot::ID, SO).unwrap();
        let auth = Keypair::new();
        svm.airdrop(&auth.pubkey(), 10_000_000_000).unwrap();
        let config = Pubkey::find_program_address(&[b"config"], &countyroot::ID).0;
        let mut e = E { svm, auth, config };
        let a = e.auth.insecure_clone();
        e.tx(&a, countyroot::instruction::InitConfig { attestor: att.pubkey() }.data(),
            countyroot::accounts::InitConfig { config, payer: a.pubkey(), system_program: Pubkey::default() }.to_account_metas(None)).unwrap();
        e
    }
    fn fund(&mut self, k: &Keypair) { self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap(); }
    fn tx(&mut self, k: &Keypair, data: Vec<u8>, metas: Vec<AccountMeta>) -> R {
        let ix = Instruction::new_with_bytes(countyroot::ID, &data, metas);
        let tx = Transaction::new(&[k], Message::new(&[ix], Some(&k.pubkey())), self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx).map(|m| m.logs).map_err(|e| format!("{:?}", e.meta.logs));
        self.svm.expire_blockhash();
        r
    }
    fn set_attestor(&mut self, k: &Keypair, new_attestor: Pubkey) -> R {
        let c = self.config;
        self.tx(k, countyroot::instruction::SetAttestor { new_attestor }.data(),
            countyroot::accounts::SetAttestor { config: c, authority: k.pubkey() }.to_account_metas(None))
    }
    fn set_paused(&mut self, paused: bool) -> R {
        let (a, c) = (self.auth.insecure_clone(), self.config);
        self.tx(&a, countyroot::instruction::SetPaused { paused }.data(),
            countyroot::accounts::SetPaused { config: c, authority: a.pubkey() }.to_account_metas(None))
    }
    fn post(&mut self, k: &Keypair, fips: u32) -> R {
        let c = self.config;
        self.tx(k, countyroot::instruction::PostRoot { fips, epoch: 1, n_parcels: 1, merkle_root: [1u8; 32], schema: [0u8; 32] }.data(),
            countyroot::accounts::PostRoot { config: c, county_root: cr(fips), attestor: k.pubkey(), system_program: Pubkey::default() }.to_account_metas(None))
    }
    fn update(&mut self, k: &Keypair, fips: u32) -> R {
        let c = self.config;
        self.tx(k, countyroot::instruction::UpdateRoot { n_parcels: 2, merkle_root: [2u8; 32], schema: [0u8; 32] }.data(),
            countyroot::accounts::UpdateRoot { config: c, county_root: cr(fips), attestor: k.pubkey() }.to_account_metas(None))
    }
    fn retract(&mut self, k: &Keypair, fips: u32) -> R {
        let c = self.config;
        self.tx(k, countyroot::instruction::RetractRoot {}.data(),
            countyroot::accounts::RetractRoot { config: c, county_root: cr(fips), attestor: k.pubkey() }.to_account_metas(None))
    }
    fn attestor(&self) -> Pubkey {
        Pubkey::try_from(&self.svm.get_account(&self.config).unwrap().data[40..72]).unwrap()
    }
}

fn bad_att(r: R) { let e = r.unwrap_err(); assert!(e.contains("BadAttestor"), "{e}"); }

#[test]
fn rotate_old_loses_new_gains() {
    let (old, new) = (Keypair::new(), Keypair::new());
    let mut e = E::new(&old);
    e.fund(&old); e.fund(&new);
    e.post(&old, 1).unwrap(); // existing root posted by the old key
    let auth = e.auth.insecure_clone();
    let mut c: solana_clock::Clock = e.svm.get_sysvar();
    c.slot = 555; c.unix_timestamp = 1_760_003_000; e.svm.set_sysvar(&c);
    let ev: AttestorChanged = event(&e.set_attestor(&auth, new.pubkey()).unwrap());
    assert_eq!((ev.authority, ev.old, ev.new, ev.slot, ev.ts), (auth.pubkey(), old.pubkey(), new.pubkey(), 555, 1_760_003_000));
    assert_eq!(e.attestor(), new.pubkey());

    bad_att(e.post(&old, 2));
    bad_att(e.update(&old, 1));
    bad_att(e.retract(&old, 1));

    e.post(&new, 2).unwrap();
    e.update(&new, 1).unwrap(); // new key can manage roots posted by the old key
    e.retract(&new, 1).unwrap();
}

#[test]
fn non_authority_rejected() {
    let att = Keypair::new();
    let mut e = E::new(&att);
    e.fund(&att);
    let err = e.set_attestor(&att, Keypair::new().pubkey()).unwrap_err(); // attestor can't rotate itself
    assert!(err.contains("BadAuthority"), "{err}");
    assert_eq!(e.attestor(), att.pubkey());
}

#[test]
fn zero_key_rejected() {
    let att = Keypair::new();
    let mut e = E::new(&att);
    let auth = e.auth.insecure_clone();
    let err = e.set_attestor(&auth, Pubkey::default()).unwrap_err();
    assert!(err.contains("ZeroAttestor"), "{err}");
    assert_eq!(e.attestor(), att.pubkey());
}

#[test]
fn rotation_works_while_paused() {
    let (old, new) = (Keypair::new(), Keypair::new());
    let mut e = E::new(&old);
    e.fund(&new);
    e.set_paused(true).unwrap();
    let auth = e.auth.insecure_clone();
    e.set_attestor(&auth, new.pubkey()).unwrap();
    assert_eq!(e.attestor(), new.pubkey());
    let err = e.post(&new, 1).unwrap_err(); // still paused
    assert!(err.contains("Paused"), "{err}");
    e.set_paused(false).unwrap();
    e.post(&new, 1).unwrap();
}
