//! Shared helpers for the v2 instructions (post_root_v2 / retract_root_v2 / migration).
#![allow(dead_code)]
use anchor_lang::{prelude::{AccountMeta, Pubkey}, InstructionData, ToAccountMetas};
use countyroot::Provenance;

pub const SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot.so");
/// Built with `cargo build-sbf --arch v0 --features devnet` and copied here by scripts/build-programs.sh.
pub const SO_DEVNET: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/countyroot-devnet.so");

pub fn cr(fips: u32, epoch: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"county_root", &fips.to_le_bytes(), &epoch.to_le_bytes()], &countyroot::ID).0
}
pub fn head(fips: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"county_head", &fips.to_le_bytes()], &countyroot::ID).0
}
pub fn config() -> Pubkey { Pubkey::find_program_address(&[b"config"], &countyroot::ID).0 }

pub fn prov(seed: u8) -> Provenance {
    Provenance {
        manifest_sha256: [seed; 32], source_sha256: [seed.wrapping_add(1); 32], packet_sha256: [seed.wrapping_add(2); 32],
        data_as_of: 1_760_000_000, fetched_at: 1_760_100_000, leaf_version: 2,
    }
}

/// post_root_v2 instruction; `prev` = Some(previous latest epoch) when it is ACTIVE.
pub fn post_v2(att: Pubkey, fips: u32, epoch: u32, prev: Option<u32>, root: [u8; 32], p: Provenance) -> (Vec<u8>, Vec<AccountMeta>) {
    (countyroot::instruction::PostRootV2 { fips, epoch, n_parcels: 42, merkle_root: root, schema: [9u8; 32], prov: p }.data(),
     countyroot::accounts::PostRootV2 {
        config: config(), county_head: head(fips), county_root: cr(fips, epoch),
        prev_root: prev.map(|e| cr(fips, e)), attestor: att, system_program: Pubkey::default(),
     }.to_account_metas(None))
}

pub fn retract_v2(att: Pubkey, fips: u32, epoch: u32, reason: u8) -> (Vec<u8>, Vec<AccountMeta>) {
    (countyroot::instruction::RetractRootV2 { reason }.data(),
     countyroot::accounts::RetractRootV2 { config: config(), county_root: cr(fips, epoch), county_head: head(fips), attestor: att }.to_account_metas(None))
}

pub fn close(auth: Pubkey, fips: u32, epoch: u32) -> (Vec<u8>, Vec<AccountMeta>) {
    (countyroot::instruction::CloseRoot {}.data(),
     countyroot::accounts::CloseRoot { config: config(), county_root: cr(fips, epoch), authority: auth }.to_account_metas(None))
}

use base64::Engine;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Instruction, Message};
use solana_signer::Signer;
use solana_transaction::Transaction;
use anchor_lang::{AnchorDeserialize, Discriminator};

pub type R = Result<Vec<String>, String>;

pub struct H { pub svm: LiteSVM, pub auth: Keypair, pub att: Keypair }

impl H {
    pub fn new(so: &str) -> H {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(countyroot::ID, so).unwrap();
        let (auth, att) = (Keypair::new(), Keypair::new());
        svm.airdrop(&auth.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&att.pubkey(), 100_000_000_000).unwrap();
        let mut h = H { svm, auth, att };
        let a = h.auth.insecure_clone();
        let att_pk = h.att.pubkey();
        h.send(&a, countyroot::instruction::InitConfig { attestor: att_pk }.data(),
            countyroot::accounts::InitConfig { config: config(), payer: a.pubkey(), system_program: Pubkey::default() }.to_account_metas(None)).unwrap();
        h
    }
    pub fn send(&mut self, k: &Keypair, data: Vec<u8>, metas: Vec<AccountMeta>) -> R {
        let ix = Instruction::new_with_bytes(countyroot::ID, &data, metas);
        let tx = Transaction::new(&[k], Message::new(&[ix], Some(&k.pubkey())), self.svm.latest_blockhash());
        let r = self.svm.send_transaction(tx).map(|m| m.logs).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs));
        self.svm.expire_blockhash();
        r
    }
    pub fn att_send(&mut self, dm: (Vec<u8>, Vec<AccountMeta>)) -> R { let a = self.att.insecure_clone(); self.send(&a, dm.0, dm.1) }
    pub fn auth_send(&mut self, dm: (Vec<u8>, Vec<AccountMeta>)) -> R { let a = self.auth.insecure_clone(); self.send(&a, dm.0, dm.1) }
    pub fn post(&mut self, fips: u32, epoch: u32, prev: Option<u32>) -> R {
        let att = self.att.pubkey();
        self.att_send(post_v2(att, fips, epoch, prev, [epoch as u8 + 10; 32], prov(epoch as u8)))
    }
    pub fn retract(&mut self, fips: u32, epoch: u32, reason: u8) -> R {
        let att = self.att.pubkey();
        self.att_send(retract_v2(att, fips, epoch, reason))
    }
    pub fn set_paused(&mut self, paused: bool) -> R {
        let a = self.auth.pubkey();
        self.auth_send((countyroot::instruction::SetPaused { paused }.data(),
            countyroot::accounts::SetPaused { config: config(), authority: a }.to_account_metas(None)))
    }
    pub fn data(&self, k: &Pubkey) -> Vec<u8> { self.svm.get_account(k).map(|a| a.data).unwrap_or_default() }
    pub fn root(&self, fips: u32, epoch: u32) -> countyroot::CountyRoot {
        countyroot::CountyRoot::deserialize(&mut &self.data(&cr(fips, epoch))[8..]).unwrap()
    }
    pub fn head(&self, fips: u32) -> countyroot::CountyHead {
        countyroot::CountyHead::deserialize(&mut &self.data(&head(fips))[8..]).unwrap()
    }
    pub fn set_clock(&mut self, slot: u64, ts: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.slot = slot; c.unix_timestamp = ts; self.svm.set_sysvar(&c);
    }
    /// Inject a legacy CountyRoot exactly as the old program wrote it: 98 bytes (v0) or 99 bytes (v1, version byte 1).
    pub fn inject_legacy(&mut self, fips: u32, epoch: u32, len: usize, status: u8) {
        let (k, bump) = Pubkey::find_program_address(&[b"county_root", &fips.to_le_bytes(), &epoch.to_le_bytes()], &countyroot::ID);
        let mut d = countyroot::CountyRoot::DISCRIMINATOR.to_vec();
        d.extend(fips.to_le_bytes()); d.extend(epoch.to_le_bytes()); d.extend(1234u64.to_le_bytes());
        d.extend([0xabu8; 32]); d.extend([0xcdu8; 32]); d.push(status); d.extend(1_700_000_000i64.to_le_bytes()); d.push(bump);
        assert_eq!(d.len(), 98);
        if len == 99 { d.push(1); }
        let lamports = self.svm.minimum_balance_for_rent_exemption(len);
        self.svm.set_account(k, solana_account::Account { lamports, data: d, owner: countyroot::ID, executable: false, rent_epoch: 0 }).unwrap();
    }
}

pub fn err_has(r: R, s: &str) { let e = r.unwrap_err(); assert!(e.contains(s), "want {s}: {e}"); }

pub fn events<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> Vec<T> {
    logs.iter().filter_map(|l| l.strip_prefix("Program data: "))
        .map(|b| base64::engine::general_purpose::STANDARD.decode(b).unwrap())
        .filter(|r| r.starts_with(T::DISCRIMINATOR))
        .map(|r| T::deserialize(&mut &r[T::DISCRIMINATOR.len()..]).unwrap()).collect()
}
pub fn event<T: AnchorDeserialize + Discriminator>(logs: &[String]) -> T {
    let mut v = events::<T>(logs); assert_eq!(v.len(), 1); v.remove(0)
}

pub fn u32_at(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }
pub fn i64_at(d: &[u8], o: usize) -> i64 { i64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
pub fn u64_at(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }

pub fn init_head_ix(att: Pubkey, fips: u32, latest_epoch: u32) -> (Vec<u8>, Vec<AccountMeta>) {
    (countyroot::instruction::InitHead { fips, latest_epoch }.data(),
     countyroot::accounts::InitHead { config: config(), county_head: head(fips), latest_root: cr(fips, latest_epoch), attestor: att, system_program: Pubkey::default() }.to_account_metas(None))
}
pub fn migrate_ix(att: Pubkey, fips: u32, epoch: u32, p: Provenance) -> (Vec<u8>, Vec<AccountMeta>) {
    (countyroot::instruction::MigrateRoot { prov: p }.data(),
     countyroot::accounts::MigrateRoot { config: config(), county_root: cr(fips, epoch), attestor: att, system_program: Pubkey::default() }.to_account_metas(None))
}
pub fn supersede_ix(att: Pubkey, fips: u32, epoch: u32, by: u32) -> (Vec<u8>, Vec<AccountMeta>) {
    (countyroot::instruction::MarkSuperseded { superseded_by: by }.data(),
     countyroot::accounts::MarkSuperseded { config: config(), county_root: cr(fips, epoch), county_head: head(fips), attestor: att }.to_account_metas(None))
}
