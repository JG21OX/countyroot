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
        root.posted_at = Clock::get()?.unix_timestamp;
        root.bump = ctx.bumps.county_root;
        Ok(())
    }

    pub fn retract_root(ctx: Context<RetractRoot>) -> Result<()> {
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        ctx.accounts.county_root.status = STATUS_RETRACTED;
        Ok(())
    }
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
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = attestor,
        space = 8 + 4 + 4 + 8 + 32 + 32 + 1 + 8 + 1,
        seeds = [b"county_root".as_ref(), fips.to_le_bytes().as_ref(), epoch.to_le_bytes().as_ref()],
        bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    #[account(mut)]
    pub attestor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RetractRoot<'info> {
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"county_root".as_ref(), county_root.fips.to_le_bytes().as_ref(), county_root.epoch.to_le_bytes().as_ref()],
        bump = county_root.bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    pub attestor: Signer<'info>,
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
}
