//! Account, PDA, status and proof-shape checks (negative tests).
mod common;
use common::*;
use countyroot_verify::*;
use solana_account_info::AccountInfo;
use solana_pubkey::Pubkey;

struct Acc { key: Pubkey, owner: Pubkey, lamports: u64, data: Vec<u8> }
impl Acc {
    fn new(key: Pubkey, data: Vec<u8>) -> Acc { Acc { key, owner: PROGRAM_ID, lamports: 1, data } }
    fn info(&mut self) -> AccountInfo<'_> { AccountInfo::new(&self.key, false, false, &mut self.lamports, &mut self.data, &self.owner, false) }
}

/// A 5-leaf tree in county 48453, epoch 3, and a proof for leaf 4 (the promoted one) and leaf 1.
fn setup() -> (Vec<Vec<u8>>, Vec<Vec<[u8; 32]>>, [u8; 32]) {
    let ids: Vec<Vec<u8>> = ["A1", "B2", "C3", "D4", "E5"].iter().map(|s| s.as_bytes().to_vec()).collect();
    let leaves: Vec<[u8; 32]> = ids.iter().map(|id| leaf_hash(48453, &ParcelRow { id, occ: 0, acres_micro: 7, sqft_centi: 9 }).unwrap()).collect();
    let lv = tree(&leaves);
    let root = root_hash(48453, 3, 5, lv.last().unwrap().first().unwrap());
    (ids, lv, root)
}
fn row(id: &[u8]) -> ParcelRow<'_> { ParcelRow { id, occ: 0, acres_micro: 7, sqft_centi: 9 } }

fn run(rd: (Pubkey, Vec<u8>), hd: Option<(Pubkey, Vec<u8>)>, fips: u32, id: &[u8], index: u64, sibs: &[[u8; 32]], pol: Freshness) -> Result<RootView, VerifyError> {
    let mut r = Acc::new(rd.0, rd.1);
    let mut h = hd.map(|(k, d)| Acc::new(k, d));
    let hi = h.as_mut().map(|h| h.info());
    verify_parcel(&r.info(), hi.as_ref(), fips, &row(id), &Proof { index, siblings: sibs }, pol)
}

#[test]
fn happy_path_all_policies() {
    let (ids, lv, root) = setup();
    for i in 0..5 {
        let s = proof_of(&lv, i);
        let v = run(root_data(48453, 3, 5, root, STATUS_ACTIVE), Some(head_data(48453, 3, 3)), 48453, &ids[i], i as u64, &s, Freshness::LatestActive).unwrap();
        assert!(v.fetched_at_is_upper_bound() && !v.migrated());
        run(root_data(48453, 3, 5, root, STATUS_ACTIVE), None, 48453, &ids[i], i as u64, &s, Freshness::ActiveOrSuperseded).unwrap();
        run(root_data(48453, 3, 5, root, STATUS_ACTIVE), None, 48453, &ids[i], i as u64, &s, Freshness::Exact(3)).unwrap();
    }
}

#[test]
fn status_policies() {
    let (ids, lv, root) = setup();
    let s = proof_of(&lv, 1);
    let go = |st: u8, head: Option<(Pubkey, Vec<u8>)>, pol| run(root_data(48453, 3, 5, root, st), head, 48453, &ids[1], 1, &s, pol);
    for pol in [Freshness::LatestActive, Freshness::ActiveOrSuperseded, Freshness::Exact(3)] {
        assert_eq!(go(STATUS_RETRACTED, Some(head_data(48453, 3, 3)), pol), Err(VerifyError::Retracted));
    }
    assert_eq!(go(STATUS_SUPERSEDED, Some(head_data(48453, 4, 4)), Freshness::LatestActive), Err(VerifyError::Superseded));
    assert_eq!(go(STATUS_ACTIVE, Some(head_data(48453, 4, 4)), Freshness::LatestActive), Err(VerifyError::Superseded));
    assert_eq!(go(STATUS_SUPERSEDED, None, Freshness::ActiveOrSuperseded).unwrap().status, STATUS_SUPERSEDED);
    go(STATUS_SUPERSEDED, None, Freshness::Exact(3)).unwrap();
    assert_eq!(go(STATUS_ACTIVE, None, Freshness::Exact(2)), Err(VerifyError::EpochMismatch));
    assert_eq!(go(STATUS_ACTIVE, Some(head_data(48453, 4, 0)), Freshness::LatestActive), Err(VerifyError::NoActiveRoot));
    assert_eq!(go(STATUS_ACTIVE, None, Freshness::LatestActive), Err(VerifyError::HeadRequired));
    assert_eq!(go(STATUS_ACTIVE, Some(head_data(40113, 3, 3)), Freshness::LatestActive), Err(VerifyError::FipsMismatch));
    assert_eq!(go(7, Some(head_data(48453, 3, 3)), Freshness::ActiveOrSuperseded), Err(VerifyError::BadStatus));
}

#[test]
fn account_checks() {
    let (ids, lv, root) = setup();
    let s = proof_of(&lv, 1);
    let ok = || root_data(48453, 3, 5, root, STATUS_ACTIVE);
    let call = |rd: (Pubkey, Vec<u8>), owner: Pubkey, hd: Option<(Pubkey, Vec<u8>, Pubkey)>| {
        let mut r = Acc::new(rd.0, rd.1); r.owner = owner;
        let mut h = hd.map(|(k, d, o)| { let mut a = Acc::new(k, d); a.owner = o; a });
        let hi = h.as_mut().map(|h| h.info());
        verify_parcel(&r.info(), hi.as_ref(), 48453, &row(&ids[1]), &Proof { index: 1, siblings: &s }, Freshness::LatestActive)
    };
    let hd = || { let (k, d) = head_data(48453, 3, 3); Some((k, d, PROGRAM_ID)) };
    call(ok(), PROGRAM_ID, hd()).unwrap();
    // wrong owner (look-alike account from another program)
    assert_eq!(call(ok(), Pubkey::new_unique(), hd()), Err(VerifyError::WrongOwner));
    // right data, wrong address
    assert_eq!(call((Pubkey::new_unique(), ok().1), PROGRAM_ID, hd()), Err(VerifyError::WrongPda));
    // data claims another epoch than its address
    let (a, mut d) = ok(); d[12] = 4; assert_eq!(call((a, d), PROGRAM_ID, hd()), Err(VerifyError::WrongPda));
    // wrong bump
    let (a, mut d) = ok(); d[97] = d[97].wrapping_sub(1); assert!(matches!(call((a, d), PROGRAM_ID, hd()), Err(VerifyError::WrongPda)));
    // legacy 98/99-byte layouts, truncated, wrong discriminator, wrong version byte
    for len in [98usize, 99, 255] { let (a, d) = ok(); assert_eq!(call((a, d[..len].to_vec()), PROGRAM_ID, hd()), Err(VerifyError::BadLayout)); }
    let (a, mut d) = ok(); d[0] ^= 1; assert_eq!(call((a, d), PROGRAM_ID, hd()), Err(VerifyError::BadLayout));
    let (a, mut d) = ok(); d[98] = 1; assert_eq!(call((a, d), PROGRAM_ID, hd()), Err(VerifyError::BadLayout));
    // v1 schema / leaf version 1
    let (a, mut d) = ok(); d[56] ^= 1; assert_eq!(call((a, d), PROGRAM_ID, hd()), Err(VerifyError::WrongSchema));
    let (a, mut d) = ok(); d[232] = 1; assert_eq!(call((a, d), PROGRAM_ID, hd()), Err(VerifyError::WrongSchema));
    // fake heads
    let (hk, hdat) = head_data(48453, 3, 3);
    assert_eq!(call(ok(), PROGRAM_ID, Some((hk, hdat.clone(), Pubkey::new_unique()))), Err(VerifyError::WrongOwner));
    assert_eq!(call(ok(), PROGRAM_ID, Some((Pubkey::new_unique(), hdat.clone(), PROGRAM_ID))), Err(VerifyError::WrongPda));
    let mut hb = hdat.clone(); hb[0] ^= 1; assert_eq!(call(ok(), PROGRAM_ID, Some((hk, hb, PROGRAM_ID))), Err(VerifyError::BadLayout));
    // caller asks about a different county
    let mut r = Acc::new(ok().0, ok().1);
    assert_eq!(verify_parcel(&r.info(), None, 40113, &row(&ids[1]), &Proof { index: 1, siblings: &s }, Freshness::ActiveOrSuperseded), Err(VerifyError::FipsMismatch));
}

#[test]
fn proof_shape_checks() {
    let (ids, lv, root) = setup();
    let go = |id: &[u8], i: u64, s: &[[u8; 32]]| run(root_data(48453, 3, 5, root, STATUS_ACTIVE), None, 48453, id, i, s, Freshness::ActiveOrSuperseded);
    let s1 = proof_of(&lv, 1);
    let s4 = proof_of(&lv, 4);
    assert_eq!(s4.len(), 1); // leaf 4 is promoted twice, then pairs once
    go(&ids[4], 4, &s4).unwrap();
    assert_eq!(go(&ids[1], 5, &s1), Err(VerifyError::IndexOutOfRange));
    assert_eq!(go(&ids[1], u64::MAX, &s1), Err(VerifyError::IndexOutOfRange));
    let mut extra = s1.clone(); extra.push([0; 32]); assert_eq!(go(&ids[1], 1, &extra), Err(VerifyError::BadProofLength));
    assert_eq!(go(&ids[1], 1, &s1[..s1.len() - 1]), Err(VerifyError::BadProofLength));
    let mut rev = s1.clone(); rev.reverse(); assert_eq!(go(&ids[1], 1, &rev), Err(VerifyError::RootMismatch));
    let mut flip = s1.clone(); flip[0][31] ^= 1; assert_eq!(go(&ids[1], 1, &flip), Err(VerifyError::RootMismatch));
    assert_eq!(go(&ids[1], 0, &proof_of(&lv, 0)), Err(VerifyError::RootMismatch)); // right proof, wrong row
    assert_eq!(go(b"B2 ", 1, &s1), Err(VerifyError::BadId));
    assert_eq!(go(b"", 1, &s1), Err(VerifyError::BadId));
    assert_eq!(go(&[b'A'; 257], 1, &s1), Err(VerifyError::BadId));
    assert_eq!(go("B\u{e9}".as_bytes(), 1, &s1), Err(VerifyError::BadId));
    assert_eq!(go(b"B\t2", 1, &s1), Err(VerifyError::BadId));
    assert!(check_id(&[b'~'; 256]).is_ok());
    let big = vec![[0u8; 32]; 33]; assert_eq!(fold([0; 32], &Proof { index: 0, siblings: &big }, u64::MAX), Err(VerifyError::BadProofLength));
}

#[test]
fn live_devnet_snapshot_passes_full_check() {
    let live = fixture("devnet-accounts.json");
    let real = fixture("real-proofs.json");
    for (label, rk, hk, fips) in [("Travis.TX", "root_48453_3", "head_48453", 48453u32), ("Osage.OK", "root_40113_3", "head_40113", 40113), ("LosAngeles.CA", "root_6037_2", "head_6037", 6037)] {
        let acc = |k: &str| { let a = &live[k]; Acc { key: a["address"].as_str().unwrap().parse().unwrap(), owner: a["owner"].as_str().unwrap().parse().unwrap(), lamports: 1,
            data: base64::Engine::decode(&base64::engine::general_purpose::STANDARD, a["data"].as_str().unwrap()).unwrap() } };
        let (mut r, mut h) = (acc(rk), acc(hk));
        let p = P::from(&real[label]["proofs"][1]);
        let v = verify_parcel(&r.info(), Some(&h.info()), fips, &p.row(), &p.proof(), Freshness::LatestActive).unwrap();
        assert!(v.fetched_at > 1_700_000_000, "{label}");
    }
}

#[test]
fn discriminators_are_anchor_account_hashes() {
    assert_eq!(ROOT_DISCRIMINATOR, solana_sha256_hasher::hash(b"account:CountyRoot").to_bytes()[..8]);
    assert_eq!(HEAD_DISCRIMINATOR, solana_sha256_hasher::hash(b"account:CountyHead").to_bytes()[..8]);
}
