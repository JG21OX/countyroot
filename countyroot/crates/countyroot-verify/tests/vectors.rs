//! Byte-for-byte parity with the TypeScript reference (sdk/src/leafv2.ts) and real county proofs.
mod common;
use common::*;
use countyroot_verify::*;

#[test]
fn schema_constant_matches_reference() {
    assert_eq!(hex::encode(SCHEMA_V2), fixture("vectors.json")["schema_v2"].as_str().unwrap());
}

#[test]
fn leaf_vectors() {
    let v = fixture("vectors.json");
    for l in v["leaves"].as_array().unwrap() {
        let r = &l["row"];
        let row = ParcelRow { id: r["id"].as_str().unwrap().as_bytes(), occ: r["occ"].as_u64().unwrap() as u32,
            acres_micro: r["acres_micro"].as_str().unwrap().parse().unwrap(), sqft_centi: r["sqft_centi"].as_str().unwrap().parse().unwrap() };
        assert_eq!(hex::encode(leaf_hash(l["fips"].as_u64().unwrap() as u32, &row).unwrap()), l["leaf"].as_str().unwrap());
    }
}

#[test]
fn synthetic_trees() {
    let v = fixture("vectors.json");
    let mut n_proofs = 0;
    for t in v["trees"].as_array().unwrap() {
        let (fips, epoch, n) = (t["fips"].as_u64().unwrap() as u32, t["epoch"].as_u64().unwrap() as u32, t["n_leaves"].as_u64().unwrap());
        assert_eq!(hex::encode(root_hash(fips, epoch, n, &h32(t["top"].as_str().unwrap()))), t["root"].as_str().unwrap());
        for p in t["proofs"].as_array().unwrap() {
            let p = P::from(p);
            let root = RootView { fips, epoch, n_parcels: n, merkle_root: h32(t["root"].as_str().unwrap()), status: STATUS_ACTIVE,
                posted_at: 0, manifest_sha256: [0; 32], source_sha256: [0; 32], packet_sha256: [0; 32], data_as_of: 0, fetched_at: 0,
                posted_slot: 0, status_changed_at: 0, superseded_by: 0, retract_reason: 0, flags: 0 };
            verify_against(&root, &p.row(), &p.proof()).unwrap();
            assert_eq!(expected_siblings(p.index, n), Some(p.sibs.len()));
            n_proofs += 1;
        }
    }
    assert!(n_proofs >= 60, "{n_proofs}");
}

#[test]
fn real_county_proofs_verify_against_their_live_roots() {
    let real = fixture("real-proofs.json");
    let live = fixture("devnet-accounts.json");
    for (label, key) in [("Travis.TX", "root_48453_3"), ("Osage.OK", "root_40113_3"), ("LosAngeles.CA", "root_6037_2")] {
        let c = &real[label];
        // the live Devnet account carries the same root the packet rebuilds to
        let a = &live[key];
        let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, a["data"].as_str().unwrap()).unwrap();
        let addr: solana_pubkey::Pubkey = a["address"].as_str().unwrap().parse().unwrap();
        let owner: solana_pubkey::Pubkey = a["owner"].as_str().unwrap().parse().unwrap();
        let root = parse_root(&addr, &owner, &data).unwrap();
        assert_eq!(hex::encode(root.merkle_root), c["root"].as_str().unwrap(), "{label}");
        assert_eq!(root.n_parcels, c["n_leaves"].as_u64().unwrap());
        assert_eq!(root.status, STATUS_ACTIVE);
        for p in c["proofs"].as_array().unwrap() {
            let p = P::from(p);
            verify_against(&root, &p.row(), &p.proof()).unwrap();
            // and a one-unit change in acreage must fail
            let mut bad = P::from(&c["proofs"][0]); bad.acres ^= 1;
            assert_eq!(verify_against(&root, &bad.row(), &bad.proof()), Err(VerifyError::RootMismatch));
        }
    }
}
