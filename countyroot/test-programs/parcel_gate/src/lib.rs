//! parcel_gate: example program using `countyroot-verify` (no CPI into CountyRoot).
//!
//! Instruction data: `tag u8` then, for tags 1 and 2, the verify args:
//!   fips u32 | index u64 | occ u32 | acres_micro u64 | sqft_centi u64 | id_len u16 | id | n_siblings u8 | siblings [32]*n
//! tag 0: no-op (compute baseline).
//! tag 1: verify only, accounts [county_root, county_head].
//! tag 2: verify and write a receipt PDA ["receipt", fips, leaf], accounts
//!        [county_root, county_head, payer (signer, w), receipt (w), system_program].
use countyroot_verify::{leaf_hash, verify_parcel, Freshness, ParcelRow, Proof};
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, program::invoke_signed,
    program_error::ProgramError, pubkey::Pubkey, rent::Rent, sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process);

pub const RECEIPT_LEN: usize = 4 + 4 + 32 + 8;

pub struct Args<'a> { pub fips: u32, pub row: ParcelRow<'a>, pub index: u64, pub siblings: &'a [[u8; 32]] }

fn take<'a>(d: &mut &'a [u8], n: usize) -> Result<&'a [u8], ProgramError> {
    if d.len() < n { return Err(ProgramError::InvalidInstructionData); }
    let (a, b) = d.split_at(n); *d = b; Ok(a)
}
pub fn parse(mut d: &[u8]) -> Result<Args<'_>, ProgramError> {
    let fips = u32::from_le_bytes(take(&mut d, 4)?.try_into().unwrap());
    let index = u64::from_le_bytes(take(&mut d, 8)?.try_into().unwrap());
    let occ = u32::from_le_bytes(take(&mut d, 4)?.try_into().unwrap());
    let acres_micro = u64::from_le_bytes(take(&mut d, 8)?.try_into().unwrap());
    let sqft_centi = u64::from_le_bytes(take(&mut d, 8)?.try_into().unwrap());
    let id_len = u16::from_le_bytes(take(&mut d, 2)?.try_into().unwrap()) as usize;
    let id = take(&mut d, id_len)?;
    let n = take(&mut d, 1)?[0] as usize;
    let raw = take(&mut d, n * 32)?;
    if !d.is_empty() { return Err(ProgramError::InvalidInstructionData); }
    // [u8] -> [[u8;32]] without copying (alignment 1).
    let (chunks, rest) = raw.as_chunks::<32>();
    debug_assert!(rest.is_empty());
    Ok(Args { fips, row: ParcelRow { id, occ, acres_micro, sqft_centi }, index, siblings: chunks })
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    if tag == 0 { return Ok(()); }
    let a = parse(rest)?;
    let [root, head, more @ ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    let view = verify_parcel(root, Some(head), a.fips, &a.row, &Proof { index: a.index, siblings: a.siblings }, Freshness::LatestActive)
        .map_err(|e| ProgramError::Custom(e.code()))?;
    if tag == 1 { return Ok(()); }
    if tag != 2 { return Err(ProgramError::InvalidInstructionData); }
    let [payer, receipt, _system, ..] = more else { return Err(ProgramError::NotEnoughAccountKeys) };
    let leaf = leaf_hash(a.fips, &a.row).map_err(|e| ProgramError::Custom(e.code()))?;
    let (pda, bump) = Pubkey::find_program_address(&[b"receipt", &a.fips.to_le_bytes(), &leaf], program_id);
    if receipt.key != &pda { return Err(ProgramError::InvalidSeeds); }
    invoke_signed(
        &solana_system_interface::instruction::create_account(payer.key, receipt.key, Rent::get()?.minimum_balance(RECEIPT_LEN), RECEIPT_LEN as u64, program_id),
        &[payer.clone(), receipt.clone()],
        &[&[b"receipt", &a.fips.to_le_bytes(), &leaf, &[bump]]],
    )?;
    let mut d = receipt.try_borrow_mut_data()?;
    d[0..4].copy_from_slice(&view.fips.to_le_bytes());
    d[4..8].copy_from_slice(&view.epoch.to_le_bytes());
    d[8..40].copy_from_slice(&leaf);
    d[40..48].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    Ok(())
}
