//! Writes real program-produced account bytes + logs to sdk/test/fixtures/v2.json for the SDK tests.
//! Run: COUNTYROOT_WRITE_FIXTURES=1 cargo test --test fixtures   (otherwise only checks they build)
mod common;
use common::*;
use ::countyroot::*;
use base64::Engine;
use solana_signer::Signer;

#[test]
fn write_sdk_fixtures() {
    let b64 = |d: &[u8]| base64::engine::general_purpose::STANDARD.encode(d);
    let mut h = H::new(SO_DEVNET);
    let att = h.att.pubkey();
    // legacy 99-byte root, then migrated
    h.inject_legacy(6037, 1, 99, STATUS_ACTIVE);
    let legacy = h.data(&cr(6037, 1));
    let mut p = prov(7); p.source_sha256 = [0; 32];
    h.att_send(migrate_ix(att, 6037, 1, p)).unwrap();
    let migrated = h.data(&cr(6037, 1));
    // v2 flow
    h.set_clock(1000, 1_760_200_000);
    let post1 = h.post(48453, 1, None).unwrap();
    h.set_clock(2000, 1_760_300_000);
    let post2 = h.post(48453, 2, Some(1)).unwrap();
    let superseded = h.data(&cr(48453, 1));
    let active = h.data(&cr(48453, 2));
    let head_active = h.data(&head(48453));
    h.set_clock(3000, 1_760_400_000);
    let retr = h.retract(48453, 2, REASON_PII).unwrap();
    let retracted = h.data(&cr(48453, 2));
    let head_none = h.data(&head(48453));
    let logs = |l: &Vec<String>| format!("[{}]", l.iter().map(|s| format!("{:?}", s)).collect::<Vec<_>>().join(","));
    let json = format!(
        "{{\n\"programId\":\"{}\",\n\"legacy99\":\"{}\",\n\"migrated\":\"{}\",\n\"superseded\":\"{}\",\n\"active\":\"{}\",\n\"retracted\":\"{}\",\n\"headActive\":\"{}\",\n\"headNone\":\"{}\",\n\"logsPost1\":{},\n\"logsPost2\":{},\n\"logsRetract\":{}\n}}\n",
        ::countyroot::ID, b64(&legacy), b64(&migrated), b64(&superseded), b64(&active), b64(&retracted), b64(&head_active), b64(&head_none),
        logs(&post1), logs(&post2), logs(&retr));
    if std::env::var("COUNTYROOT_WRITE_FIXTURES").is_ok() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../sdk/test/fixtures/v2.json");
        std::fs::create_dir_all(std::path::Path::new(p).parent().unwrap()).unwrap();
        std::fs::write(p, json).unwrap();
    }
}
