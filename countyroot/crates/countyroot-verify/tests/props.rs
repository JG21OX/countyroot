//! Property tests: random trees, every index verifies, any single mutation fails.
mod common;
use common::*;
use countyroot_verify::*;
use proptest::prelude::*;

fn view(fips: u32, epoch: u32, n: u64, root: [u8; 32]) -> RootView {
    RootView { fips, epoch, n_parcels: n, merkle_root: root, status: STATUS_ACTIVE, posted_at: 0, manifest_sha256: [0; 32],
        source_sha256: [0; 32], packet_sha256: [0; 32], data_as_of: 0, fetched_at: 0, posted_slot: 0, status_changed_at: 0,
        superseded_by: 0, retract_reason: 0, flags: 0 }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]
    #[test]
    fn random_trees(n in 1usize..300, fips in 1001u32..99999, epoch in 1u32..10, seed in any::<u64>(), pick in any::<prop::sample::Index>(), mutate in 0usize..6) {
        let ids: Vec<Vec<u8>> = (0..n).map(|i| format!("P{seed:x}-{i}").into_bytes()).collect();
        let rows: Vec<(u32, u64, u64)> = (0..n).map(|i| (i as u32 % 3, seed.wrapping_mul(i as u64 + 1), i as u64)).collect();
        let leaves: Vec<[u8; 32]> = (0..n).map(|i| leaf_hash(fips, &ParcelRow { id: &ids[i], occ: rows[i].0, acres_micro: rows[i].1, sqft_centi: rows[i].2 }).unwrap()).collect();
        let lv = tree(&leaves);
        let root = root_hash(fips, epoch, n as u64, &lv.last().unwrap()[0]);
        let v = view(fips, epoch, n as u64, root);
        let i = pick.index(n);
        let mut sibs = proof_of(&lv, i);
        prop_assert_eq!(expected_siblings(i as u64, n as u64), Some(sibs.len()));
        let mut id = ids[i].clone();
        let (mut occ, mut acres, sqft, mut idx, mut vv) = (rows[i].0, rows[i].1, rows[i].2, i as u64, v);
        let r = ParcelRow { id: &id, occ, acres_micro: acres, sqft_centi: sqft };
        let pr = Proof { index: idx, siblings: &sibs };
        let ok = verify_against(&v, &r, &pr).is_ok();
        prop_assert!(ok);
        match mutate {
            0 => occ ^= 1,
            1 => acres ^= 1,
            2 => id.push(b'X'),
            3 => { if sibs.is_empty() { vv.epoch += 1 } else { sibs[0][0] ^= 0x80 } }
            4 => { if n > 1 { idx = (idx + 1) % n as u64 } else { vv.fips += 1 } }
            _ => { vv.n_parcels += 1; }
        }
        let r = ParcelRow { id: &id, occ, acres_micro: acres, sqft_centi: sqft };
        let pr = Proof { index: idx, siblings: &sibs };
        let bad = verify_against(&vv, &r, &pr).is_err();
        prop_assert!(bad);
    }
}
