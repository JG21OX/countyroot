//! # countyroot-verify
//!
//! Check, inside your own Solana program, that a parcel row is part of a CountyRoot
//! county root posted on-chain. No CPI: you pass the CountyRoot account (and the
//! county's CountyHead for the "latest" policy) and the crate does every check itself.
//!
//! A successful check means: *the CountyRoot attestor posted a root for this county and
//! epoch, it has not been retracted, and this exact row (id, occurrence, acres, lot size)
//! is leaf `index` of it.* It is not a title guarantee. See the README for the trust model.
//!
//! Exactly one of the `devnet` / `mainnet` features must be enabled.
#![no_std]
#![deny(unsafe_code)]

#[cfg(not(any(feature = "devnet", feature = "mainnet")))]
compile_error!("countyroot-verify: enable exactly one of the features `devnet` or `mainnet`");
#[cfg(all(feature = "devnet", feature = "mainnet"))]
compile_error!("countyroot-verify: features `devnet` and `mainnet` are mutually exclusive");
#[cfg(feature = "mainnet")]
compile_error!("countyroot-verify: CountyRoot is not deployed on Mainnet yet; the `mainnet` feature ships with that deploy");

use solana_account_info::AccountInfo;
use solana_pubkey::Pubkey;
use solana_sha256_hasher::hashv;

/// The CountyRoot program on the selected cluster.
#[cfg(feature = "devnet")]
pub const PROGRAM_ID: Pubkey = solana_pubkey::pubkey!("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
#[cfg(not(feature = "devnet"))]
pub const PROGRAM_ID: Pubkey = Pubkey::new_from_array([0; 32]);

pub const ROOT_SEED: &[u8] = b"county_root";
pub const HEAD_SEED: &[u8] = b"county_head";

/// sha256 of the leaf v2 spec identifier, stored in `CountyRoot.schema`.
pub const SCHEMA_V2: [u8; 32] = [
    0xb3, 0x09, 0x04, 0x3c, 0x77, 0xb9, 0xaa, 0x52, 0x92, 0x44, 0x03, 0x3e, 0xcb, 0xca, 0xa0, 0x30,
    0x61, 0x5f, 0xa9, 0x49, 0x99, 0x3c, 0x83, 0x5b, 0xad, 0xe2, 0x1f, 0xd2, 0xab, 0xfb, 0xf0, 0x0d,
];
pub const LEAF_TAG_V2: &[u8] = b"countyroot/leaf/v2";
pub const ROOT_TAG_V2: &[u8] = b"countyroot/root/v2";
/// Value of `acres_micro` / `sqft_centi` meaning "not provided".
pub const NOT_PROVIDED: u64 = u64::MAX;

/// Anchor discriminators: sha256("account:CountyRoot")[..8] and sha256("account:CountyHead")[..8].
pub const ROOT_DISCRIMINATOR: [u8; 8] = [0x61, 0x16, 0xe2, 0xb1, 0x34, 0x3a, 0xe2, 0xad];
pub const HEAD_DISCRIMINATOR: [u8; 8] = [0x2b, 0x39, 0x1b, 0x69, 0x27, 0x58, 0xf2, 0x41];

pub const STATUS_ACTIVE: u8 = 1;
pub const STATUS_RETRACTED: u8 = 2;
pub const STATUS_SUPERSEDED: u8 = 3;
pub const FLAG_MIGRATED: u8 = 1;
pub const FLAG_FETCHED_AT_IS_UPPER_BOUND: u8 = 2;

pub const ROOT_V2_LEN: usize = 256;
pub const HEAD_LEN: usize = 48;
/// Longest parcel id the v2 builder accepts.
pub const MAX_ID_LEN: usize = 256;
/// More siblings than any 2^32-leaf tree needs; bounds compute.
pub const MAX_SIBLINGS: usize = 32;

// CountyRoot v2 layout (bytes 0..98 are the original Borsh body).
const OFF_FIPS: usize = 8;
const OFF_EPOCH: usize = 12;
const OFF_N_PARCELS: usize = 16;
const OFF_MERKLE_ROOT: usize = 24;
const OFF_SCHEMA: usize = 56;
const OFF_STATUS: usize = 88;
const OFF_POSTED_AT: usize = 89;
const OFF_BUMP: usize = 97;
const OFF_VERSION: usize = 98;
const OFF_MANIFEST_SHA256: usize = 99;
const OFF_SOURCE_SHA256: usize = 131;
const OFF_PACKET_SHA256: usize = 163;
const OFF_DATA_AS_OF: usize = 195;
const OFF_FETCHED_AT: usize = 203;
const OFF_POSTED_SLOT: usize = 211;
const OFF_STATUS_CHANGED_AT: usize = 219;
const OFF_SUPERSEDED_BY: usize = 227;
const OFF_RETRACT_REASON: usize = 231;
const OFF_LEAF_VERSION: usize = 232;
const OFF_FLAGS: usize = 233;
// CountyHead layout.
const H_FIPS: usize = 8;
const H_LATEST_EPOCH: usize = 12;
const H_LATEST_ACTIVE: usize = 16;
const H_N_EPOCHS: usize = 20;
const H_UPDATED_AT: usize = 24;
const H_BUMP: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum VerifyError {
    /// The account is not owned by the CountyRoot program.
    WrongOwner = 1,
    /// The account is not at the CountyRoot / CountyHead PDA for its fips (and epoch).
    WrongPda,
    /// Wrong size, discriminator or layout version (legacy 98/99-byte roots are refused).
    BadLayout,
    /// The root is not a leaf-v2 root.
    WrongSchema,
    /// The root was retracted. Never accepted.
    Retracted,
    /// The root was replaced by a later epoch and the policy wants the latest one.
    Superseded,
    /// The county has no active root (its latest epoch was retracted).
    NoActiveRoot,
    /// The root (or head) is for a different county than the caller asked about.
    FipsMismatch,
    /// The root is not the epoch the caller pinned.
    EpochMismatch,
    /// `index >= n_parcels`.
    IndexOutOfRange,
    /// Too many or too few siblings for (index, n_parcels).
    BadProofLength,
    /// The proof does not reproduce the posted root.
    RootMismatch,
    /// Parcel id is empty, longer than 256 bytes, not printable ASCII, or has outer spaces.
    BadId,
    /// The policy needs the CountyHead account and none was passed.
    HeadRequired,
    /// Unknown status byte.
    BadStatus,
}

impl VerifyError {
    /// Stable number for `ProgramError::Custom(e.code())`: 0x4352_0000 + n ("CR"), so it does not clash with your own codes.
    pub const fn code(self) -> u32 { 0x4352_0000 + self as u32 }
}
/// Which roots count as good enough.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[derive(Default)]
pub enum Freshness {
    /// The root must be the county's latest ACTIVE epoch. Needs the CountyHead. (Default.)
    #[default]
    LatestActive,
    /// ACTIVE or SUPERSEDED: "this row was in epoch E". Check `RootView::status` yourself.
    ActiveOrSuperseded,
    /// Exactly this epoch, ACTIVE or SUPERSEDED (e.g. an epoch you stored earlier).
    Exact(u32),
}

/// A parcel row as it appears in a v2 packet / proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParcelRow<'a> {
    pub id: &'a [u8],
    pub occ: u32,
    pub acres_micro: u64,
    pub sqft_centi: u64,
}

/// A membership proof. `n_leaves` is never taken from the caller; it comes from the root account.
#[derive(Clone, Copy, Debug)]
pub struct Proof<'a> {
    pub index: u64,
    pub siblings: &'a [[u8; 32]],
}

/// Decoded CountyRoot v2 account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RootView {
    pub fips: u32,
    pub epoch: u32,
    pub n_parcels: u64,
    pub merkle_root: [u8; 32],
    pub status: u8,
    pub posted_at: i64,
    pub manifest_sha256: [u8; 32],
    pub source_sha256: [u8; 32],
    pub packet_sha256: [u8; 32],
    /// County's own edit date (unix seconds), 0 if unknown.
    pub data_as_of: i64,
    /// Download time, or a "fetched no later than" bound when `fetched_at_is_upper_bound()`.
    pub fetched_at: i64,
    pub posted_slot: u64,
    pub status_changed_at: i64,
    pub superseded_by: u32,
    pub retract_reason: u8,
    pub flags: u8,
}
impl RootView {
    pub fn migrated(&self) -> bool { self.flags & FLAG_MIGRATED != 0 }
    pub fn fetched_at_is_upper_bound(&self) -> bool { self.flags & FLAG_FETCHED_AT_IS_UPPER_BOUND != 0 }
}

/// Decoded CountyHead account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadView {
    pub fips: u32,
    pub latest_epoch: u32,
    /// 0 = no active root.
    pub latest_active_epoch: u32,
    pub n_epochs: u32,
    pub updated_at: i64,
}

fn u32_at(d: &[u8], o: usize) -> u32 { u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) }
fn u64_at(d: &[u8], o: usize) -> u64 { let mut b = [0u8; 8]; b.copy_from_slice(&d[o..o + 8]); u64::from_le_bytes(b) }
fn i64_at(d: &[u8], o: usize) -> i64 { u64_at(d, o) as i64 }
fn b32_at(d: &[u8], o: usize) -> [u8; 32] { let mut b = [0u8; 32]; b.copy_from_slice(&d[o..o + 32]); b }

/// Parse and check raw CountyRoot account data at `address` owned by `owner`.
/// Checks owner, size, discriminator, layout version, PDA, leaf-v2 schema and status byte.
/// Does NOT apply a freshness policy (retracted roots are returned, with `status == STATUS_RETRACTED`).
pub fn parse_root(address: &Pubkey, owner: &Pubkey, data: &[u8]) -> Result<RootView, VerifyError> {
    if owner != &PROGRAM_ID { return Err(VerifyError::WrongOwner); }
    if data.len() != ROOT_V2_LEN || data[..8] != ROOT_DISCRIMINATOR || data[OFF_VERSION] != 2 {
        return Err(VerifyError::BadLayout);
    }
    let fips = u32_at(data, OFF_FIPS);
    let epoch = u32_at(data, OFF_EPOCH);
    let pda = Pubkey::create_program_address(
        &[ROOT_SEED, &fips.to_le_bytes(), &epoch.to_le_bytes(), &[data[OFF_BUMP]]], &PROGRAM_ID)
        .map_err(|_| VerifyError::WrongPda)?;
    if &pda != address { return Err(VerifyError::WrongPda); }
    if data[OFF_SCHEMA..OFF_SCHEMA + 32] != SCHEMA_V2 || data[OFF_LEAF_VERSION] != 2 {
        return Err(VerifyError::WrongSchema);
    }
    let status = data[OFF_STATUS];
    if !matches!(status, STATUS_ACTIVE | STATUS_RETRACTED | STATUS_SUPERSEDED) { return Err(VerifyError::BadStatus); }
    Ok(RootView {
        fips, epoch,
        n_parcels: u64_at(data, OFF_N_PARCELS),
        merkle_root: b32_at(data, OFF_MERKLE_ROOT),
        status,
        posted_at: i64_at(data, OFF_POSTED_AT),
        manifest_sha256: b32_at(data, OFF_MANIFEST_SHA256),
        source_sha256: b32_at(data, OFF_SOURCE_SHA256),
        packet_sha256: b32_at(data, OFF_PACKET_SHA256),
        data_as_of: i64_at(data, OFF_DATA_AS_OF),
        fetched_at: i64_at(data, OFF_FETCHED_AT),
        posted_slot: u64_at(data, OFF_POSTED_SLOT),
        status_changed_at: i64_at(data, OFF_STATUS_CHANGED_AT),
        superseded_by: u32_at(data, OFF_SUPERSEDED_BY),
        retract_reason: data[OFF_RETRACT_REASON],
        flags: data[OFF_FLAGS],
    })
}

/// Parse and check raw CountyHead account data (owner, size, discriminator, PDA).
pub fn parse_head(address: &Pubkey, owner: &Pubkey, data: &[u8]) -> Result<HeadView, VerifyError> {
    if owner != &PROGRAM_ID { return Err(VerifyError::WrongOwner); }
    if data.len() != HEAD_LEN || data[..8] != HEAD_DISCRIMINATOR { return Err(VerifyError::BadLayout); }
    let fips = u32_at(data, H_FIPS);
    let pda = Pubkey::create_program_address(&[HEAD_SEED, &fips.to_le_bytes(), &[data[H_BUMP]]], &PROGRAM_ID)
        .map_err(|_| VerifyError::WrongPda)?;
    if &pda != address { return Err(VerifyError::WrongPda); }
    Ok(HeadView {
        fips,
        latest_epoch: u32_at(data, H_LATEST_EPOCH),
        latest_active_epoch: u32_at(data, H_LATEST_ACTIVE),
        n_epochs: u32_at(data, H_N_EPOCHS),
        updated_at: i64_at(data, H_UPDATED_AT),
    })
}

/// [`parse_root`] for an `AccountInfo`.
pub fn load_root(acct: &AccountInfo) -> Result<RootView, VerifyError> {
    let data = acct.try_borrow_data().map_err(|_| VerifyError::BadLayout)?;
    parse_root(acct.key, acct.owner, &data)
}
/// [`parse_head`] for an `AccountInfo`.
pub fn load_head(acct: &AccountInfo) -> Result<HeadView, VerifyError> {
    let data = acct.try_borrow_data().map_err(|_| VerifyError::BadLayout)?;
    parse_head(acct.key, acct.owner, &data)
}

/// Same rule as the v2 builder: 1..=256 bytes, printable ASCII 0x20..=0x7E, no leading/trailing space.
pub fn check_id(id: &[u8]) -> Result<(), VerifyError> {
    if id.is_empty() || id.len() > MAX_ID_LEN || id[0] == b' ' || id[id.len() - 1] == b' '
        || id.iter().any(|&c| !(0x20..=0x7e).contains(&c)) {
        return Err(VerifyError::BadId);
    }
    Ok(())
}

/// leaf = sha256(0x00 ‖ "countyroot/leaf/v2" ‖ u32 fips ‖ u16 len ‖ id ‖ u32 occ ‖ u64 acres_micro ‖ u64 sqft_centi)
pub fn leaf_hash(fips: u32, row: &ParcelRow) -> Result<[u8; 32], VerifyError> {
    check_id(row.id)?;
    Ok(hashv(&[&[0x00], LEAF_TAG_V2, &fips.to_le_bytes(), &(row.id.len() as u16).to_le_bytes(), row.id,
        &row.occ.to_le_bytes(), &row.acres_micro.to_le_bytes(), &row.sqft_centi.to_le_bytes()]).to_bytes())
}
/// node = sha256(0x01 ‖ left ‖ right)
pub fn node_hash(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] { hashv(&[&[0x01], l, r]).to_bytes() }
/// root = sha256(0x02 ‖ "countyroot/root/v2" ‖ u32 fips ‖ u32 epoch ‖ u64 n_leaves ‖ top)
pub fn root_hash(fips: u32, epoch: u32, n_leaves: u64, top: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[0x02], ROOT_TAG_V2, &fips.to_le_bytes(), &epoch.to_le_bytes(), &n_leaves.to_le_bytes(), top]).to_bytes()
}

/// Number of siblings a proof for `index` in an `n`-leaf tree has (odd last node is promoted, no sibling).
pub fn expected_siblings(index: u64, n: u64) -> Option<usize> {
    if index >= n { return None; }
    let (mut i, mut n, mut s) = (index, n, 0usize);
    while n > 1 {
        if !(i == n - 1 && n % 2 == 1) { s += 1; }
        i >>= 1; n = n.div_ceil(2);
    }
    Some(s)
}

/// Fold a leaf up to the tree top (not the bound root). Rejects any sibling count other than the exact one.
pub fn fold(leaf: [u8; 32], proof: &Proof, n_leaves: u64) -> Result<[u8; 32], VerifyError> {
    if proof.index >= n_leaves { return Err(VerifyError::IndexOutOfRange); }
    if proof.siblings.len() > MAX_SIBLINGS || expected_siblings(proof.index, n_leaves) != Some(proof.siblings.len()) {
        return Err(VerifyError::BadProofLength);
    }
    let (mut node, mut i, mut n, mut s) = (leaf, proof.index, n_leaves, 0usize);
    while n > 1 {
        if !(i == n - 1 && n % 2 == 1) {
            let sib = &proof.siblings[s]; s += 1;
            node = if i & 1 == 1 { node_hash(sib, &node) } else { node_hash(&node, sib) };
        }
        i >>= 1; n = n.div_ceil(2);
    }
    Ok(node)
}

/// Pure proof check against a decoded root (no account checks). Most callers want [`verify_parcel`].
pub fn verify_against(root: &RootView, row: &ParcelRow, proof: &Proof) -> Result<(), VerifyError> {
    let leaf = leaf_hash(root.fips, row)?;
    let top = fold(leaf, proof, root.n_parcels)?;
    if root_hash(root.fips, root.epoch, root.n_parcels, &top) != root.merkle_root { return Err(VerifyError::RootMismatch); }
    Ok(())
}

/// Apply a freshness policy to a decoded root (and head when present). Retracted is always rejected.
pub fn check_policy(root: &RootView, head: Option<&HeadView>, policy: Freshness) -> Result<(), VerifyError> {
    if root.status == STATUS_RETRACTED { return Err(VerifyError::Retracted); }
    if let Some(h) = head { if h.fips != root.fips { return Err(VerifyError::FipsMismatch); } }
    match policy {
        Freshness::LatestActive => {
            let h = head.ok_or(VerifyError::HeadRequired)?;
            if h.latest_active_epoch == 0 { return Err(VerifyError::NoActiveRoot); }
            if root.status != STATUS_ACTIVE || h.latest_active_epoch != root.epoch { return Err(VerifyError::Superseded); }
        }
        Freshness::ActiveOrSuperseded => {}
        Freshness::Exact(e) => if root.epoch != e { return Err(VerifyError::EpochMismatch); },
    }
    Ok(())
}

/// Full check: account owner/PDA/layout/schema, county, freshness policy, then the Merkle proof.
/// `head` is required for [`Freshness::LatestActive`] and optional otherwise (checked if given).
pub fn verify_parcel(root: &AccountInfo, head: Option<&AccountInfo>, fips: u32, row: &ParcelRow,
                     proof: &Proof, policy: Freshness) -> Result<RootView, VerifyError> {
    let r = load_root(root)?;
    if r.fips != fips { return Err(VerifyError::FipsMismatch); }
    let h = match head { Some(a) => Some(load_head(a)?), None => None };
    check_policy(&r, h.as_ref(), policy)?;
    verify_against(&r, row, proof)?;
    Ok(r)
}

/// Address of the CountyRoot PDA (off-chain helper; on-chain prefer the stored bump).
pub fn county_root_address(fips: u32, epoch: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ROOT_SEED, &fips.to_le_bytes(), &epoch.to_le_bytes()], &PROGRAM_ID)
}
/// Address of the CountyHead PDA.
pub fn county_head_address(fips: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HEAD_SEED, &fips.to_le_bytes()], &PROGRAM_ID)
}
