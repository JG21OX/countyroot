//! Devnet-only migration (init_head / migrate_root / mark_superseded) against injected legacy
//! accounts byte-identical to what the old program wrote (98-byte v0, 99-byte v1).
//! Build first: scripts/build-programs.sh (needs target/deploy/countyroot-devnet.so).
mod common;
use common::*;
use ::countyroot::*;
use solana_signer::Signer;

const F: u32 = 6037;

fn migrated(h: &mut H, fips: u32, epoch: u32, len: usize) -> Vec<u8> {
    h.inject_legacy(fips, epoch, len, STATUS_ACTIVE);
    let before = h.data(&cr(fips, epoch));
    let att = h.att.pubkey();
    let mut p = prov(7); p.source_sha256 = [0; 32]; // D3: unknown source hash allowed for migrated roots
    let logs = h.att_send(migrate_ix(att, fips, epoch, p)).unwrap();
    let ev: RootMigrated = event(&logs);
    assert_eq!((ev.fips, ev.epoch, ev.old_len, ev.source_sha256), (fips, epoch, len as u32, [0; 32]));
    let d = h.data(&cr(fips, epoch));
    assert_eq!(&d[..98], &before[..98], "original body must be byte-identical");
    d
}

#[test]
fn migrate_v0_and_v1() {
    for len in [98usize, 99] {
        let mut h = H::new(SO_DEVNET);
        let d = migrated(&mut h, F, 1, len);
        assert_eq!(d.len(), COUNTY_ROOT_V2_LEN);
        assert_eq!((d[OFF_VERSION], d[OFF_FLAGS], d[OFF_LEAF_VERSION]), (2, FLAG_MIGRATED, 2));
        assert_eq!(&d[OFF_MANIFEST_SHA256..OFF_MANIFEST_SHA256 + 32], &[7u8; 32]);
        assert_eq!(&d[OFF_SOURCE_SHA256..OFF_SOURCE_SHA256 + 32], &[0u8; 32]);
        assert_eq!(u64_at(&d, OFF_POSTED_SLOT), 0);
        assert!(d[OFF_RESERVED..].iter().all(|b| *b == 0));
        assert_eq!(h.svm.get_account(&cr(F, 1)).unwrap().lamports, h.svm.minimum_balance_for_rent_exemption(256));
        let r = h.root(F, 1);
        assert_eq!((r.fips, r.epoch, r.n_parcels, r.status, r.posted_at), (F, 1, 1234, STATUS_ACTIVE, 1_700_000_000));
    }
}

#[test]
fn migrate_guards() {
    let mut h = H::new(SO_DEVNET);
    migrated(&mut h, F, 1, 99);
    let att = h.att.pubkey();
    err_has(h.att_send(migrate_ix(att, F, 1, prov(8))), "AlreadyMigrated");
    // zero manifest still rejected even for migrated roots
    h.inject_legacy(F, 2, 99, STATUS_ACTIVE);
    let mut p = prov(1); p.manifest_sha256 = [0; 32];
    err_has(h.att_send(migrate_ix(att, F, 2, p)), "ZeroHash");
    // retracted legacy roots are not migrated
    h.inject_legacy(F, 3, 99, STATUS_RETRACTED);
    err_has(h.att_send(migrate_ix(att, F, 3, prov(1))), "NotActive");
    // foreign-owned account at a fake address
    let fake = solana_keypair::Keypair::new().pubkey();
    let real = h.svm.get_account(&cr(F, 2)).unwrap();
    h.svm.set_account(fake, real).unwrap();
    let (d, mut m) = migrate_ix(att, F, 2, prov(1));
    m[1].pubkey = fake;
    err_has(h.att_send((d, m)), "PrevRootMismatch");
    // wrong attestor
    let x = solana_keypair::Keypair::new();
    h.svm.airdrop(&x.pubkey(), 1_000_000_000).unwrap();
    let (d, m) = migrate_ix(x.pubkey(), F, 2, prov(1));
    err_has(h.send(&x, d, m), "BadAttestor");
    h.set_paused(true).unwrap();
    err_has(h.att_send(migrate_ix(att, F, 2, prov(1))), "Paused");
}

#[test]
fn full_county_migration_then_v2_post() {
    let mut h = H::new(SO_DEVNET);
    for e in 1..=3 { migrated(&mut h, F, e, 99); }
    let att = h.att.pubkey();
    assert!(h.att_send(init_head_ix(att, F, 0)).is_err());
    h.att_send(init_head_ix(att, F, 3)).unwrap();
    assert!(h.att_send(init_head_ix(att, F, 3)).is_err(), "head is init-once");
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch, hd.n_epochs), (3, 3, 3));
    err_has(h.att_send(supersede_ix(att, F, 3, 3)), "IsLatest");
    err_has(h.att_send(supersede_ix(att, F, 1, 1)), "BadSupersededBy");
    err_has(h.att_send(supersede_ix(att, F, 1, 4)), "BadSupersededBy");
    h.att_send(supersede_ix(att, F, 1, 2)).unwrap();
    h.att_send(supersede_ix(att, F, 2, 3)).unwrap();
    err_has(h.att_send(supersede_ix(att, F, 1, 2)), "NotActive");
    let d1 = h.data(&cr(F, 1));
    assert_eq!((h.root(F, 1).status, u32_at(&d1, OFF_SUPERSEDED_BY), d1[OFF_RETRACT_REASON], d1[OFF_FLAGS]),
               (STATUS_SUPERSEDED, 2, REASON_SUPERSEDED, FLAG_MIGRATED));
    // normal v2 flow continues from the migrated head
    err_has(h.post(F, 4, None), "PrevRootRequired");
    h.post(F, 4, Some(3)).unwrap();
    assert_eq!(h.root(F, 3).status, STATUS_SUPERSEDED);
    assert_eq!(h.head(F).latest_active_epoch, 4);
}

#[test]
fn mark_superseded_on_unmigrated_legacy_root() {
    let mut h = H::new(SO_DEVNET);
    h.inject_legacy(F, 1, 98, STATUS_ACTIVE);
    h.inject_legacy(F, 2, 99, STATUS_ACTIVE);
    let att = h.att.pubkey();
    h.att_send(init_head_ix(att, F, 2)).unwrap();
    h.att_send(supersede_ix(att, F, 1, 2)).unwrap();
    let d = h.data(&cr(F, 1));
    assert_eq!(d.len(), 98, "no realloc for status-only change");
    assert_eq!(h.root(F, 1).status, STATUS_SUPERSEDED);
}

#[test]
fn retract_legacy_99_byte_root_records_event_only() {
    let mut h = H::new(SO_DEVNET);
    h.inject_legacy(F, 1, 99, STATUS_ACTIVE);
    let att = h.att.pubkey();
    h.att_send(init_head_ix(att, F, 1)).unwrap();
    let ev: RootRetractedV2 = event(&h.retract(F, 1, REASON_PII).unwrap());
    assert_eq!(ev.reason, REASON_PII);
    let d = h.data(&cr(F, 1));
    assert_eq!((d.len(), h.root(F, 1).status), (99, STATUS_RETRACTED));
    assert_eq!(h.head(F).latest_active_epoch, 0);
}

#[test]
fn retracted_latest_gets_head_with_no_active_root() {
    // D5: newest epoch retracted -> head(latest = 2, active = 0); older ACTIVE epochs superseded.
    let mut h = H::new(SO_DEVNET);
    migrated(&mut h, F, 1, 99);
    h.inject_legacy(F, 2, 99, STATUS_RETRACTED);
    let att = h.att.pubkey();
    let logs = h.att_send(init_head_ix(att, F, 2)).unwrap();
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch, hd.n_epochs), (2, 0, 2));
    let ev: HeadUpdated = event(&logs);
    assert_eq!((ev.latest_epoch, ev.latest_active_epoch), (2, 0));
    err_has(h.att_send(supersede_ix(att, F, 2, 2)), "NotActive");
    h.att_send(supersede_ix(att, F, 1, 2)).unwrap();
    assert_eq!((h.root(F, 1).status, h.root(F, 2).status), (STATUS_SUPERSEDED, STATUS_RETRACTED));
    assert_eq!(h.data(&cr(F, 2)).len(), 99, "retracted root is not migrated or resized");
    // a later v2 post starts from no active root
    h.post(F, 3, None).unwrap();
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch), (3, 3));
}

#[test]
fn init_head_rejects_superseded_latest() {
    let mut h = H::new(SO_DEVNET);
    h.inject_legacy(F, 1, 99, STATUS_SUPERSEDED);
    err_has(h.att_send(init_head_ix(h.att.pubkey(), F, 1)), "NotActive");
}
