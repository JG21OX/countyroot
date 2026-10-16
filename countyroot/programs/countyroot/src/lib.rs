// CountyRoot
//       ●
//       |
//    /--+--+--\
//   / \      / \
//  o o o o  o o o o
// program: 7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg

use anchor_lang::prelude::*;

declare_id!("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");

#[program]
pub mod countyroot {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, attestor: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.payer.key();
        cfg.attestor = attestor;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        emit!(ConfigInitialized {
            authority: cfg.authority,
            attestor,
        });
        Ok(())
    }

    pub fn post_root(
        ctx: Context<PostRoot>,
        fips: u32,
        epoch: u32,
        n_parcels: u64,
        merkle_root: [u8; 32],
        schema: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        require!(n_parcels > 0, CountyError::EmptyPacket);
        require!(merkle_root != [0u8; 32], CountyError::ZeroRoot);

        let root = &mut ctx.accounts.county_root;
        root.fips = fips;
        root.epoch = epoch;
        root.n_parcels = n_parcels;
        root.merkle_root = merkle_root;
        root.schema = schema;
        root.status = STATUS_ACTIVE;
        let clock = Clock::get()?;
        root.posted_at = clock.unix_timestamp;
        root.bump = ctx.bumps.county_root;
        // v1 accounts carry one trailing version byte after the 98-byte v0 body.
        root.to_account_info().try_borrow_mut_data()?[COUNTY_ROOT_V0_LEN] = COUNTY_ROOT_VERSION;
        emit!(RootPosted {
            county_root: root.key(),
            fips,
            epoch,
            n_parcels,
            merkle_root,
            schema,
            attestor: ctx.accounts.attestor.key(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
            version: COUNTY_ROOT_VERSION,
        });
        Ok(())
    }

    pub fn update_root(
        ctx: Context<UpdateRoot>,
        n_parcels: u64,
        merkle_root: [u8; 32],
        schema: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        require!(
            ctx.accounts.county_root.status == STATUS_ACTIVE,
            CountyError::NotActive
        );
        require!(n_parcels > 0, CountyError::EmptyPacket);
        require!(merkle_root != [0u8; 32], CountyError::ZeroRoot);

        let clock = Clock::get()?;
        let root = &mut ctx.accounts.county_root;
        let old_n_parcels = root.n_parcels;
        let old_root = root.merkle_root;
        let old_schema = root.schema;
        root.n_parcels = n_parcels;
        root.merkle_root = merkle_root;
        root.schema = schema;
        root.posted_at = clock.unix_timestamp;
        emit!(RootUpdated {
            county_root: root.key(),
            fips: root.fips,
            epoch: root.epoch,
            old_n_parcels,
            new_n_parcels: n_parcels,
            old_root,
            new_root: merkle_root,
            old_schema,
            new_schema: schema,
            attestor: ctx.accounts.attestor.key(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
            version: county_root_version(&root.to_account_info())?,
        });
        Ok(())
    }

    pub fn retract_root(ctx: Context<RetractRoot>) -> Result<()> {
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        let clock = Clock::get()?;
        let root = &mut ctx.accounts.county_root;
        let prev_status = root.status;
        root.status = STATUS_RETRACTED;
        emit!(RootRetracted {
            county_root: root.key(),
            fips: root.fips,
            epoch: root.epoch,
            merkle_root: root.merkle_root,
            prev_status,
            attestor: ctx.accounts.attestor.key(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
            version: county_root_version(&root.to_account_info())?,
        });
        Ok(())
    }

    /// Authority-only emergency stop. Idempotent: setting the current value succeeds
    /// (and still emits PauseChanged with old == new), so unpause can always be retried safely.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let clock = Clock::get()?;
        let cfg = &mut ctx.accounts.config;
        let old = cfg.paused;
        cfg.paused = paused;
        emit!(PauseChanged {
            authority: ctx.accounts.authority.key(),
            old,
            new: paused,
            slot: clock.slot,
            ts: clock.unix_timestamp,
        });
        Ok(())
    }

    pub fn close_root(ctx: Context<CloseRoot>) -> Result<()> {
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.county_root.status == STATUS_RETRACTED,
            CountyError::NotRetracted
        );
        let clock = Clock::get()?;
        let root = &ctx.accounts.county_root;
        emit!(RootClosed {
            county_root: root.key(),
            fips: root.fips,
            epoch: root.epoch,
            merkle_root: root.merkle_root,
            authority: ctx.accounts.authority.key(),
            lamports_returned: root.to_account_info().lamports(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
            version: county_root_version(&root.to_account_info())?,
        });
        Ok(())
    }
}

/// Size of a v0 CountyRoot account (8-byte discriminator + 90-byte body).
pub const COUNTY_ROOT_V0_LEN: usize = 8 + 4 + 4 + 8 + 32 + 32 + 1 + 8 + 1;
/// v1 = v0 body + 1 trailing version byte (not part of the Borsh struct, so v0 accounts still deserialize).
pub const COUNTY_ROOT_V1_LEN: usize = COUNTY_ROOT_V0_LEN + 1;
/// Layout/leaf-recipe version written by post_root today.
/// 0 = legacy account with no version byte, 1 = current layout,
/// leaf = sha256(parcel_id|acres.toFixed(6)|lot_sqft.toFixed(2)).
pub const COUNTY_ROOT_VERSION: u8 = 1;

/// Read a CountyRoot's version: 0 if the account is the legacy 98-byte layout.
pub fn county_root_version(info: &AccountInfo) -> Result<u8> {
    let data = info.try_borrow_data()?;
    Ok(if data.len() > COUNTY_ROOT_V0_LEN { data[COUNTY_ROOT_V0_LEN] } else { 0 })
}

pub const STATUS_ACTIVE: u8 = 1;
pub const STATUS_RETRACTED: u8 = 2;

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub attestor: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[account]
pub struct CountyRoot {
    pub fips: u32,
    pub epoch: u32,
    pub n_parcels: u64,
    pub merkle_root: [u8; 32],
    pub schema: [u8; 32],
    pub status: u8,
    pub posted_at: i64,
    pub bump: u8,
}

// ---------- Events ----------
// Emitted via emit! (program log "Program data: <base64>"), which needs no
// extra accounts, so existing instruction account lists stay unchanged.

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub attestor: Pubkey,
}

#[event]
pub struct RootPosted {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub n_parcels: u64,
    pub merkle_root: [u8; 32],
    pub schema: [u8; 32],
    pub attestor: Pubkey,
    pub slot: u64,
    pub ts: i64,
    /// Appended last so older decoders that ignore trailing bytes keep working.
    pub version: u8,
}

#[event]
pub struct RootUpdated {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub old_n_parcels: u64,
    pub new_n_parcels: u64,
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub old_schema: [u8; 32],
    pub new_schema: [u8; 32],
    pub attestor: Pubkey,
    pub slot: u64,
    pub ts: i64,
    /// Appended last so older decoders that ignore trailing bytes keep working.
    pub version: u8,
}

#[event]
pub struct RootRetracted {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub merkle_root: [u8; 32],
    pub prev_status: u8,
    pub attestor: Pubkey,
    pub slot: u64,
    pub ts: i64,
    /// Appended last so older decoders that ignore trailing bytes keep working.
    pub version: u8,
}

#[event]
pub struct RootClosed {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub merkle_root: [u8; 32],
    pub authority: Pubkey,
    pub lamports_returned: u64,
    pub slot: u64,
    pub ts: i64,
    /// Appended last so older decoders that ignore trailing bytes keep working.
    pub version: u8,
}

#[event]
pub struct PauseChanged {
    pub authority: Pubkey,
    pub old: bool,
    pub new: bool,
    pub slot: u64,
    pub ts: i64,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ CountyError::BadAuthority
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 1 + 1,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(fips: u32, epoch: u32)]
pub struct PostRoot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = attestor,
        space = COUNTY_ROOT_V1_LEN,
        seeds = [b"county_root".as_ref(), fips.to_le_bytes().as_ref(), epoch.to_le_bytes().as_ref()],
        bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    #[account(mut)]
    pub attestor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRoot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"county_root".as_ref(), county_root.fips.to_le_bytes().as_ref(), county_root.epoch.to_le_bytes().as_ref()],
        bump = county_root.bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    pub attestor: Signer<'info>,
}

#[derive(Accounts)]
pub struct RetractRoot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"county_root".as_ref(), county_root.fips.to_le_bytes().as_ref(), county_root.epoch.to_le_bytes().as_ref()],
        bump = county_root.bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    pub attestor: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRoot<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ CountyError::BadAuthority
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = authority,
        seeds = [b"county_root".as_ref(), county_root.fips.to_le_bytes().as_ref(), county_root.epoch.to_le_bytes().as_ref()],
        bump = county_root.bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[error_code]
pub enum CountyError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Signer is not the attestor")]
    BadAttestor,
    #[msg("n_parcels must be > 0")]
    EmptyPacket,
    #[msg("merkle_root cannot be zero")]
    ZeroRoot,
    #[msg("Root is not active")]
    NotActive,
    #[msg("Root must be retracted before it can be closed")]
    NotRetracted,
    #[msg("Signer is not the config authority")]
    BadAuthority,
}
