#![allow(dead_code)]
use countyroot_verify::*;
use serde_json::Value;
use solana_pubkey::Pubkey;

pub fn fixture(name: &str) -> Value {
    // Also used by test-programs/parcel_gate, which points back at this crate's fixtures.
    let here = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/");
    let there = concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/countyroot-verify/tests/fixtures/");
    let p = if std::path::Path::new(here).exists() { here } else { there };
    serde_json::from_str(&std::fs::read_to_string(format!("{p}{name}")).unwrap()).unwrap()
}
pub fn h32(s: &str) -> [u8; 32] { hex::decode(s).unwrap().try_into().unwrap() }

/// An owned proof decoded from the TypeScript `ProofV2` JSON.
pub struct P { pub fips: u32, pub epoch: u32, pub n: u64, pub index: u64, pub id: Vec<u8>, pub occ: u32, pub acres: u64, pub sqft: u64, pub sibs: Vec<[u8; 32]> }
impl P {
    pub fn from(v: &Value) -> P {
        let r = &v["row"];
        P { fips: v["fips"].as_u64().unwrap() as u32, epoch: v["epoch"].as_u64().unwrap() as u32, n: v["nLeaves"].as_u64().unwrap(),
            index: v["index"].as_u64().unwrap(), id: r["id"].as_str().unwrap().as_bytes().to_vec(), occ: r["occ"].as_u64().unwrap() as u32,
            acres: r["acres_micro"].as_str().unwrap().parse().unwrap(), sqft: r["sqft_centi"].as_str().unwrap().parse().unwrap(),
            sibs: v["siblings"].as_array().unwrap().iter().map(|s| h32(s.as_str().unwrap())).collect() }
    }
    pub fn row(&self) -> ParcelRow<'_> { ParcelRow { id: &self.id, occ: self.occ, acres_micro: self.acres, sqft_centi: self.sqft } }
    pub fn proof(&self) -> Proof<'_> { Proof { index: self.index, siblings: &self.sibs } }
}

/// Build a CountyRoot v2 account body exactly like post_root_v2 lays it out.
pub fn root_data(fips: u32, epoch: u32, n: u64, root: [u8; 32], status: u8) -> (Pubkey, Vec<u8>) {
    let (addr, bump) = county_root_address(fips, epoch);
    let mut d = vec![0u8; ROOT_V2_LEN];
    d[..8].copy_from_slice(&ROOT_DISCRIMINATOR);
    d[8..12].copy_from_slice(&fips.to_le_bytes());
    d[12..16].copy_from_slice(&epoch.to_le_bytes());
    d[16..24].copy_from_slice(&n.to_le_bytes());
    d[24..56].copy_from_slice(&root);
    d[56..88].copy_from_slice(&SCHEMA_V2);
    d[88] = status;
    d[89..97].copy_from_slice(&1_760_000_000i64.to_le_bytes());
    d[97] = bump;
    d[98] = 2;
    d[203..211].copy_from_slice(&1_760_100_000i64.to_le_bytes());
    d[232] = 2;
    d[233] = FLAG_FETCHED_AT_IS_UPPER_BOUND;
    (addr, d)
}
pub fn head_data(fips: u32, latest: u32, active: u32) -> (Pubkey, Vec<u8>) {
    let (addr, bump) = county_head_address(fips);
    let mut d = vec![0u8; HEAD_LEN];
    d[..8].copy_from_slice(&HEAD_DISCRIMINATOR);
    d[8..12].copy_from_slice(&fips.to_le_bytes());
    d[12..16].copy_from_slice(&latest.to_le_bytes());
    d[16..20].copy_from_slice(&active.to_le_bytes());
    d[20..24].copy_from_slice(&latest.to_le_bytes());
    d[32] = bump;
    (addr, d)
}

/// Independent reference tree builder (promote-odd), used by property tests.
pub fn tree(leaves: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
    let mut lv = vec![leaves.to_vec()];
    while lv.last().unwrap().len() > 1 {
        let c = lv.last().unwrap();
        let mut nx = Vec::new();
        for i in (0..c.len()).step_by(2) { nx.push(if i + 1 < c.len() { node_hash(&c[i], &c[i + 1]) } else { c[i] }); }
        lv.push(nx);
    }
    lv
}
pub fn proof_of(lv: &[Vec<[u8; 32]>], index: usize) -> Vec<[u8; 32]> {
    let mut s = Vec::new(); let mut i = index;
    for l in &lv[..lv.len() - 1] { if !(i == l.len() - 1 && l.len() % 2 == 1) { s.push(l[i ^ 1]); } i >>= 1; }
    s
}
