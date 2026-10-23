//! post_root_v2 / retract_root_v2 / CountyHead / SUPERSEDED. Build first: scripts/build-programs.sh
mod common;
use common::*;
use ::countyroot::*;
use solana_signer::Signer;

const F: u32 = 48453; // Travis, TX

#[test]
fn first_post_creates_head_and_v2_layout() {
    let mut h = H::new(SO);
    h.set_clock(5000, 1_760_200_000);
    let logs = h.post(F, 1, None).unwrap();
    let d = h.data(&cr(F, 1));
    assert_eq!(d.len(), COUNTY_ROOT_V2_LEN);
    assert_eq!(d[OFF_VERSION], 2);
    let p = prov(1);
    assert_eq!(&d[OFF_MANIFEST_SHA256..OFF_MANIFEST_SHA256 + 32], &p.manifest_sha256);
    assert_eq!(&d[OFF_SOURCE_SHA256..OFF_SOURCE_SHA256 + 32], &p.source_sha256);
    assert_eq!(&d[OFF_PACKET_SHA256..OFF_PACKET_SHA256 + 32], &p.packet_sha256);
    assert_eq!(i64_at(&d, OFF_DATA_AS_OF), p.data_as_of);
    assert_eq!(i64_at(&d, OFF_FETCHED_AT), p.fetched_at);
    assert_eq!(u64_at(&d, OFF_POSTED_SLOT), 5000);
    assert_eq!((i64_at(&d, OFF_STATUS_CHANGED_AT), u32_at(&d, OFF_SUPERSEDED_BY), d[OFF_RETRACT_REASON]), (0, 0, 0));
    assert_eq!((d[OFF_LEAF_VERSION], d[OFF_FLAGS]), (2, 0));
    assert!(d[OFF_RESERVED..].iter().all(|b| *b == 0));
    let r = h.root(F, 1);
    assert_eq!((r.fips, r.epoch, r.status, r.posted_at), (F, 1, STATUS_ACTIVE, 1_760_200_000));
    let hd = h.head(F);
    assert_eq!((hd.fips, hd.latest_epoch, hd.latest_active_epoch, hd.n_epochs, hd.updated_at), (F, 1, 1, 1, 1_760_200_000));
    assert_eq!(h.data(&head(F)).len(), COUNTY_HEAD_LEN);
    let ev: RootPostedV2 = event(&logs);
    assert_eq!((ev.fips, ev.epoch, ev.superseded_epoch, ev.version, ev.leaf_version), (F, 1, 0, 2, 2));
    assert_eq!((ev.manifest_sha256, ev.source_sha256, ev.packet_sha256), (p.manifest_sha256, p.source_sha256, p.packet_sha256));
    let hu: HeadUpdated = event(&logs);
    assert_eq!((hu.latest_epoch, hu.latest_active_epoch, hu.n_epochs), (1, 1, 1));
    assert!(events::<RootSuperseded>(&logs).is_empty());
}

#[test]
fn rent_matches_formula() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    let rl = h.svm.get_account(&cr(F, 1)).unwrap().lamports;
    let hl = h.svm.get_account(&head(F)).unwrap().lamports;
    // rent-exempt = (128 + len) * lamports_per_byte; litesvm uses the legacy 6960, current mainnet
    // (`solana rent`, Oct 2026) uses 5080 -> 256 B = 0.00195072 SOL, 48 B = 0.00089408 SOL, 99 B = 0.00115316 SOL.
    let per = h.svm.minimum_balance_for_rent_exemption(0) / 128;
    assert_eq!(rl, (128 + 256) * per);
    assert_eq!(hl, (128 + 48) * per);
}

#[test]
fn next_epoch_supersedes_previous_atomically() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    h.set_clock(6000, 1_760_300_000);
    let logs = h.post(F, 2, Some(1)).unwrap();
    let (r1, r2) = (h.root(F, 1), h.root(F, 2));
    assert_eq!((r1.status, r2.status), (STATUS_SUPERSEDED, STATUS_ACTIVE));
    let d1 = h.data(&cr(F, 1));
    assert_eq!((u32_at(&d1, OFF_SUPERSEDED_BY), d1[OFF_RETRACT_REASON], i64_at(&d1, OFF_STATUS_CHANGED_AT)), (2, REASON_SUPERSEDED, 1_760_300_000));
    assert_eq!(r1.merkle_root, [11u8; 32], "superseded root body is untouched");
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch, hd.n_epochs), (2, 2, 2));
    let s: RootSuperseded = event(&logs);
    assert_eq!((s.epoch, s.superseded_by), (1, 2));
    assert_eq!(event::<RootPostedV2>(&logs).superseded_epoch, 1);
}

#[test]
fn epochs_are_monotonic() {
    let mut h = H::new(SO);
    err_has(h.post(F, 2, None), "EpochNotNext"); // new county must start at 1
    h.post(F, 1, None).unwrap();
    err_has(h.post(F, 3, Some(1)), "EpochNotNext"); // gap
    h.post(F, 2, Some(1)).unwrap();
    // repeat / lower epochs: the PDA already exists, so init fails before the handler
    assert!(h.post(F, 2, Some(1)).is_err());
    assert!(h.post(F, 1, None).is_err());
}

#[test]
fn prev_root_required_and_checked() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    err_has(h.post(F, 2, None), "PrevRootRequired");
    h.post(6037, 1, None).unwrap(); // another county
    let att = h.att.pubkey();
    let (d, mut m) = post_v2(att, F, 2, Some(1), [5u8; 32], prov(5));
    // swap prev_root for a different county's ACTIVE root
    let idx = m.iter().position(|a| a.pubkey == cr(F, 1)).unwrap();
    m[idx].pubkey = cr(6037, 1);
    err_has(h.att_send((d, m)), "PrevRootMismatch");
    assert_eq!(h.root(F, 1).status, STATUS_ACTIVE);
}

#[test]
fn provenance_validated() {
    let mut h = H::new(SO);
    let att = h.att.pubkey();
    let mut p = prov(1); p.manifest_sha256 = [0; 32];
    err_has(h.att_send(post_v2(att, F, 1, None, [1; 32], p)), "ZeroHash");
    let mut p = prov(1); p.source_sha256 = [0; 32];
    err_has(h.att_send(post_v2(att, F, 1, None, [1; 32], p)), "ZeroHash");
    let mut p = prov(1); p.packet_sha256 = [0; 32];
    err_has(h.att_send(post_v2(att, F, 1, None, [1; 32], p)), "ZeroHash");
    let mut p = prov(1); p.leaf_version = 3;
    err_has(h.att_send(post_v2(att, F, 1, None, [1; 32], p)), "BadLeafVersion");
    let mut p = prov(1); p.data_as_of = p.fetched_at + 1;
    err_has(h.att_send(post_v2(att, F, 1, None, [1; 32], p)), "BadDates");
    let mut p = prov(1); p.fetched_at = 0;
    err_has(h.att_send(post_v2(att, F, 1, None, [1; 32], p)), "BadDates");
    err_has(h.att_send(post_v2(att, F, 1, None, [0; 32], prov(1))), "ZeroRoot");
    let mut p = prov(1); p.data_as_of = 0; // county doesn't expose an edit date: allowed
    h.att_send(post_v2(att, F, 1, None, [1; 32], p)).unwrap();
}

#[test]
fn fips_bounds() {
    let mut h = H::new(SO);
    for bad in [0u32, 1000, 6000, 1, 999, 78031, 79001, 90001, 99999] {
        err_has(h.post(bad, 1, None), "BadFips");
    }
    for good in [1001u32, 6037, 72153, 78030] { h.post(good, 1, None).unwrap(); }
}

#[test]
fn devnet_build_accepts_test_fips() {
    let mut h = H::new(SO_DEVNET);
    h.post(90001, 1, None).unwrap();
    err_has(h.post(6000, 1, None), "BadFips");
}

#[test]
fn retract_latest_leaves_no_active_root() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    h.post(F, 2, Some(1)).unwrap();
    h.set_clock(7000, 1_760_400_000);
    let logs = h.retract(F, 2, REASON_PII).unwrap();
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch), (2, 0));
    assert_eq!(h.root(F, 1).status, STATUS_SUPERSEDED, "D5: no silent fallback to epoch 1");
    let d = h.data(&cr(F, 2));
    assert_eq!((d[OFF_RETRACT_REASON], i64_at(&d, OFF_STATUS_CHANGED_AT)), (REASON_PII, 1_760_400_000));
    let ev: RootRetractedV2 = event(&logs);
    assert_eq!((ev.epoch, ev.prev_status, ev.reason, ev.version), (2, STATUS_ACTIVE, REASON_PII, 2));
    // next post needs no prev_root (latest is retracted) and becomes the active one
    h.post(F, 3, None).unwrap();
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch, hd.n_epochs), (3, 3, 3));
    assert_eq!(h.root(F, 2).status, STATUS_RETRACTED);
}

#[test]
fn retract_superseded_keeps_head() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    h.post(F, 2, Some(1)).unwrap();
    let ev: RootRetractedV2 = event(&h.retract(F, 1, REASON_SOURCE_ERROR).unwrap());
    assert_eq!(ev.prev_status, STATUS_SUPERSEDED);
    let hd = h.head(F);
    assert_eq!((hd.latest_epoch, hd.latest_active_epoch), (2, 2));
    let d = h.data(&cr(F, 1));
    assert_eq!((d[OFF_RETRACT_REASON], u32_at(&d, OFF_SUPERSEDED_BY)), (REASON_SOURCE_ERROR, 2));
}

#[test]
fn retract_reasons_and_double_retract() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    for bad in [REASON_NONE, REASON_SUPERSEDED, 6, 254] { err_has(h.retract(F, 1, bad), "BadReason"); }
    h.retract(F, 1, REASON_DUPLICATE).unwrap();
    err_has(h.retract(F, 1, REASON_OTHER), "AlreadyRetracted");
}

#[test]
fn wrong_head_for_root_rejected() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    h.post(6037, 1, None).unwrap();
    let att = h.att.pubkey();
    let (d, mut m) = retract_v2(att, F, 1, REASON_OTHER);
    let idx = m.iter().position(|a| a.pubkey == head(F)).unwrap();
    m[idx].pubkey = head(6037);
    err_has(h.att_send((d, m)), "ConstraintSeeds");
}

#[test]
fn close_only_retracted_never_superseded() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    h.post(F, 2, Some(1)).unwrap();
    let auth = h.auth.pubkey();
    err_has(h.auth_send(close(auth, F, 1)), "NotRetracted"); // SUPERSEDED: history is kept
    err_has(h.auth_send(close(auth, F, 2)), "NotRetracted"); // ACTIVE
    h.retract(F, 2, REASON_PII).unwrap();
    let rent = h.svm.get_account(&cr(F, 2)).unwrap().lamports;
    let before = h.svm.get_balance(&auth).unwrap();
    let logs = h.auth_send(close(auth, F, 2)).unwrap();
    assert_eq!(h.svm.get_balance(&auth).unwrap(), before + rent - 5000);
    let ev: RootClosed = event(&logs);
    assert_eq!((ev.epoch, ev.lamports_returned), (2, rent));
    // closed epoch can't be re-posted: next epoch is 3
    assert!(h.post(F, 2, None).is_err());
    h.post(F, 3, None).unwrap();
    let att = h.att.pubkey();
    err_has(h.att_send(close(att, F, 3)), "BadAuthority");
}

#[test]
fn wrong_attestor_rejected_everywhere() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    let x = solana_keypair::Keypair::new();
    h.svm.airdrop(&solana_signer::Signer::pubkey(&x), 1_000_000_000).unwrap();
    let xp = solana_signer::Signer::pubkey(&x);
    let (d, m) = post_v2(xp, F, 2, Some(1), [3; 32], prov(3));
    err_has(h.send(&x, d, m), "BadAttestor");
    let (d, m) = retract_v2(xp, F, 1, REASON_OTHER);
    err_has(h.send(&x, d, m), "BadAttestor");
}

#[test]
fn paused_blocks_v2_writes() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    h.set_paused(true).unwrap();
    err_has(h.post(F, 2, Some(1)), "Paused");
    err_has(h.post(6037, 1, None), "Paused");
    err_has(h.retract(F, 1, REASON_OTHER), "Paused");
    h.set_paused(false).unwrap();
    h.post(F, 2, Some(1)).unwrap();
}

#[test]
fn deprecated_instructions_fail() {
    let mut h = H::new(SO);
    h.post(F, 1, None).unwrap();
    let att = h.att.pubkey();
    err_has(h.att_send((::countyroot::instruction::PostRoot { fips: 6037, epoch: 1, n_parcels: 1, merkle_root: [1; 32], schema: [0; 32] }.data(),
        ::countyroot::accounts::PostRoot { config: config(), county_root: cr(6037, 1), attestor: att, system_program: Default::default() }.to_account_metas(None))), "Deprecated");
    err_has(h.att_send((::countyroot::instruction::UpdateRoot { n_parcels: 2, merkle_root: [2; 32], schema: [0; 32] }.data(),
        ::countyroot::accounts::UpdateRoot { config: config(), county_root: cr(F, 1), attestor: att }.to_account_metas(None))), "Deprecated");
    err_has(h.att_send((::countyroot::instruction::RetractRoot {}.data(),
        ::countyroot::accounts::RetractRoot { config: config(), county_root: cr(F, 1), attestor: att }.to_account_metas(None))), "Deprecated");
    assert_eq!(h.root(F, 1).merkle_root, [11u8; 32]);
    assert!(h.svm.get_account(&cr(6037, 1)).map_or(true, |a| a.lamports == 0));
}

#[test]
fn migration_instructions_disabled_in_mainnet_build() {
    let mut h = H::new(SO);
    h.inject_legacy(F, 2, 99, STATUS_ACTIVE);
    let att = h.att.pubkey();
    err_has(h.att_send(init_head_ix(att, F, 2)), "DevnetOnly");
    err_has(h.att_send(migrate_ix(att, F, 2, prov(1))), "DevnetOnly");
}
use anchor_lang::{InstructionData, ToAccountMetas};
