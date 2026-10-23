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

    /// Deprecated: bypasses the CountyHead pointer and provenance. Use post_root_v2.
    /// Kept in the interface so old clients get a clear error instead of an unknown instruction.
    #[allow(unused_variables)]
    pub fn post_root(
        _ctx: Context<PostRoot>,
        fips: u32,
        epoch: u32,
        n_parcels: u64,
        merkle_root: [u8; 32],
        schema: [u8; 32],
    ) -> Result<()> {
        err!(CountyError::Deprecated)
    }

    /// Deprecated (decision D2): posted roots are immutable; corrections are new epochs.
    #[allow(unused_variables)]
    pub fn update_root(
        _ctx: Context<UpdateRoot>,
        n_parcels: u64,
        merkle_root: [u8; 32],
        schema: [u8; 32],
    ) -> Result<()> {
        err!(CountyError::Deprecated)
    }

    /// Deprecated: no reason, no head update. Use retract_root_v2.
    pub fn retract_root(_ctx: Context<RetractRoot>) -> Result<()> {
        err!(CountyError::Deprecated)
    }

    /// Post a new epoch with provenance. Epochs are monotonic per county
    /// (epoch == head.latest_epoch + 1; a brand-new county starts at 1). If the previous
    /// latest epoch is still ACTIVE it must be passed as `prev_root` and is marked
    /// SUPERSEDED in the same transaction.
    pub fn post_root_v2(
        ctx: Context<PostRootV2>,
        fips: u32,
        epoch: u32,
        n_parcels: u64,
        merkle_root: [u8; 32],
        schema: [u8; 32],
        prov: Provenance,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        require!(valid_fips(fips), CountyError::BadFips);
        require!(n_parcels > 0, CountyError::EmptyPacket);
        require!(merkle_root != [0u8; 32], CountyError::ZeroRoot);
        prov.check()?;

        let clock = Clock::get()?;
        let head = &mut ctx.accounts.county_head;
        if head.n_epochs == 0 && head.latest_epoch == 0 {
            // Freshly created by init_if_needed (or never used).
            head.fips = fips;
            head.bump = ctx.bumps.county_head;
        }
        require!(head.fips == fips, CountyError::HeadMismatch);
        require!(
            head.latest_epoch.checked_add(1) == Some(epoch),
            CountyError::EpochNotNext
        );

        let mut superseded_epoch = 0u32;
        let prev_should_supersede = head.latest_epoch != 0 && head.latest_active_epoch == head.latest_epoch;
        if prev_should_supersede {
            let prev = ctx.accounts.prev_root.as_mut().ok_or(CountyError::PrevRootRequired)?;
            let (want, _) = county_root_address(fips, head.latest_epoch);
            require_keys_eq!(prev.key(), want, CountyError::PrevRootMismatch);
            require!(prev.status == STATUS_ACTIVE, CountyError::NotActive);
            prev.status = STATUS_SUPERSEDED;
            let info = prev.to_account_info();
            write_superseded_tail(&info, epoch, clock.unix_timestamp)?;
            superseded_epoch = prev.epoch;
            emit!(RootSuperseded {
                county_root: prev.key(),
                fips,
                epoch: prev.epoch,
                superseded_by: epoch,
                slot: clock.slot,
                ts: clock.unix_timestamp,
            });
        }

        let root = &mut ctx.accounts.county_root;
        root.fips = fips;
        root.epoch = epoch;
        root.n_parcels = n_parcels;
        root.merkle_root = merkle_root;
        root.schema = schema;
        root.status = STATUS_ACTIVE;
        root.posted_at = clock.unix_timestamp;
        root.bump = ctx.bumps.county_root;
        {
            let info = root.to_account_info();
            let mut d = info.try_borrow_mut_data()?;
            d[OFF_VERSION] = COUNTY_ROOT_VERSION;
            write_provenance(&mut d, &prov);
            d[OFF_POSTED_SLOT..OFF_POSTED_SLOT + 8].copy_from_slice(&clock.slot.to_le_bytes());
        }

        head.latest_epoch = epoch;
        head.latest_active_epoch = epoch;
        head.n_epochs = head.n_epochs.checked_add(1).ok_or(CountyError::EpochNotNext)?;
        head.updated_at = clock.unix_timestamp;

        emit!(RootPostedV2 {
            county_root: root.key(),
            fips,
            epoch,
            n_parcels,
            merkle_root,
            schema,
            manifest_sha256: prov.manifest_sha256,
            source_sha256: prov.source_sha256,
            packet_sha256: prov.packet_sha256,
            data_as_of: prov.data_as_of,
            fetched_at: prov.fetched_at,
            leaf_version: prov.leaf_version,
            superseded_epoch,
            attestor: ctx.accounts.attestor.key(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
            version: COUNTY_ROOT_VERSION,
        });
        let hk = head.key();
        emit_head(&*head, hk, &clock);
        Ok(())
    }

    /// Retract an ACTIVE or SUPERSEDED root with a reason (PII, SOURCE_ERROR, DUPLICATE,
    /// BUILD_ERROR, OTHER). Retracting the latest active epoch leaves the county with no
    /// active root (latest_active_epoch = 0) until a new epoch is posted (decision D5).
    pub fn retract_root_v2(ctx: Context<RetractRootV2>, reason: u8) -> Result<()> {
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        require!(
            matches!(reason, REASON_PII | REASON_SOURCE_ERROR | REASON_DUPLICATE | REASON_BUILD_ERROR | REASON_OTHER),
            CountyError::BadReason
        );
        let clock = Clock::get()?;
        let root = &mut ctx.accounts.county_root;
        let prev_status = root.status;
        require!(
            prev_status == STATUS_ACTIVE || prev_status == STATUS_SUPERSEDED,
            CountyError::AlreadyRetracted
        );
        root.status = STATUS_RETRACTED;
        let info = root.to_account_info();
        {
            let mut d = info.try_borrow_mut_data()?;
            if d.len() >= COUNTY_ROOT_V2_LEN {
                d[OFF_STATUS_CHANGED_AT..OFF_STATUS_CHANGED_AT + 8].copy_from_slice(&clock.unix_timestamp.to_le_bytes());
                d[OFF_RETRACT_REASON] = reason;
            }
        }
        let head = &mut ctx.accounts.county_head;
        if head.latest_active_epoch == root.epoch {
            head.latest_active_epoch = 0;
        }
        head.updated_at = clock.unix_timestamp;
        emit!(RootRetractedV2 {
            county_root: root.key(),
            fips: root.fips,
            epoch: root.epoch,
            merkle_root: root.merkle_root,
            prev_status,
            reason,
            attestor: ctx.accounts.attestor.key(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
            version: county_root_version(&info)?,
        });
        let hk = head.key();
        emit_head(&*head, hk, &clock);
        Ok(())
    }

    /// DEVNET MIGRATION ONLY. Create the CountyHead for a county whose latest posted
    /// epoch is `latest_epoch` (must exist and be ACTIVE, or RETRACTED: then the head has
    /// latest_active_epoch = 0, decision D5). The caller (the migration
    /// script) is responsible for checking that no higher epoch exists.
    pub fn init_head(ctx: Context<InitHead>, fips: u32, latest_epoch: u32) -> Result<()> {
        require!(cfg!(feature = "devnet"), CountyError::DevnetOnly);
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        require!(valid_fips(fips), CountyError::BadFips);
        require!(latest_epoch > 0, CountyError::EpochNotNext);
        // D5: a county whose newest epoch was retracted gets a head with no active root
        // (latest_active_epoch = 0); its older ACTIVE epochs are then marked superseded.
        let latest_active_epoch = match ctx.accounts.latest_root.status {
            STATUS_ACTIVE => latest_epoch,
            STATUS_RETRACTED => 0,
            _ => return err!(CountyError::NotActive),
        };
        let clock = Clock::get()?;
        let head = &mut ctx.accounts.county_head;
        head.fips = fips;
        head.latest_epoch = latest_epoch;
        head.latest_active_epoch = latest_active_epoch;
        head.n_epochs = latest_epoch;
        head.updated_at = clock.unix_timestamp;
        head.bump = ctx.bumps.county_head;
        let hk = head.key();
        emit_head(&*head, hk, &clock);
        Ok(())
    }

    /// DEVNET MIGRATION ONLY. Grow a legacy 98/99-byte ACTIVE root to the 256-byte v2
    /// layout and record its provenance (flags.migrated = 1, posted_slot = 0 = unknown).
    /// `fetched_at_is_upper_bound`: no recorded download time exists, so `prov.fetched_at` is the
    /// "fetched no later than" time (commit or post time); sets FLAG_FETCHED_AT_IS_UPPER_BOUND.
    /// Bytes 0..98 (the original account body) are never touched.
    pub fn migrate_root(ctx: Context<MigrateRoot>, prov: Provenance, fetched_at_is_upper_bound: bool) -> Result<()> {
        require!(cfg!(feature = "devnet"), CountyError::DevnetOnly);
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        prov.check_migrated()?;
        let clock = Clock::get()?;
        let info = ctx.accounts.county_root.to_account_info();
        let old_len = info.data_len();
        require!(old_len < COUNTY_ROOT_V2_LEN, CountyError::AlreadyMigrated);
        let (fips, epoch, status) = {
            let d = info.try_borrow_data()?;
            let r = CountyRoot::try_deserialize(&mut &d[..])?;
            (r.fips, r.epoch, r.status)
        };
        require!(status == STATUS_ACTIVE, CountyError::NotActive);
        let (want, _) = county_root_address(fips, epoch);
        require_keys_eq!(info.key(), want, CountyError::PrevRootMismatch);

        let rent = Rent::get()?;
        let need = rent.minimum_balance(COUNTY_ROOT_V2_LEN).saturating_sub(info.lamports());
        if need > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.attestor.to_account_info(),
                        to: info.clone(),
                    },
                ),
                need,
            )?;
        }
        info.resize(COUNTY_ROOT_V2_LEN)?;
        {
            let mut d = info.try_borrow_mut_data()?;
            for b in d[COUNTY_ROOT_V0_LEN..].iter_mut() { *b = 0; }
            d[OFF_VERSION] = COUNTY_ROOT_VERSION;
            write_provenance(&mut d, &prov);
            d[OFF_FLAGS] = FLAG_MIGRATED
                | if fetched_at_is_upper_bound { FLAG_FETCHED_AT_IS_UPPER_BOUND } else { 0 };
        }
        emit!(RootMigrated {
            county_root: info.key(),
            fips,
            epoch,
            old_len: old_len as u32,
            manifest_sha256: prov.manifest_sha256,
            source_sha256: prov.source_sha256,
            packet_sha256: prov.packet_sha256,
            data_as_of: prov.data_as_of,
            fetched_at: prov.fetched_at,
            leaf_version: prov.leaf_version,
            fetched_at_is_upper_bound,
            attestor: ctx.accounts.attestor.key(),
            slot: clock.slot,
            ts: clock.unix_timestamp,
        });
        Ok(())
    }

    /// DEVNET MIGRATION ONLY. Mark an older ACTIVE epoch as SUPERSEDED by a later one.
    /// Works on 98/99-byte accounts (status lives in the original body) without realloc.
    pub fn mark_superseded(ctx: Context<MarkSuperseded>, superseded_by: u32) -> Result<()> {
        require!(cfg!(feature = "devnet"), CountyError::DevnetOnly);
        require!(!ctx.accounts.config.paused, CountyError::Paused);
        require!(
            ctx.accounts.attestor.key() == ctx.accounts.config.attestor,
            CountyError::BadAttestor
        );
        let clock = Clock::get()?;
        let head = &ctx.accounts.county_head;
        let root = &mut ctx.accounts.county_root;
        require!(root.status == STATUS_ACTIVE, CountyError::NotActive);
        require!(root.epoch < head.latest_epoch, CountyError::IsLatest);
        require!(
            superseded_by > root.epoch && superseded_by <= head.latest_epoch,
            CountyError::BadSupersededBy
        );
        root.status = STATUS_SUPERSEDED;
        let info = root.to_account_info();
        write_superseded_tail(&info, superseded_by, clock.unix_timestamp)?;
        emit!(RootSuperseded {
            county_root: root.key(),
            fips: root.fips,
            epoch: root.epoch,
            superseded_by,
            slot: clock.slot,
            ts: clock.unix_timestamp,
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

    /// Authority-only attestor rotation. Deliberately ignores `paused`, so a compromised
    /// attestor can be swapped while writes are frozen.
    pub fn set_attestor(ctx: Context<SetAttestor>, new_attestor: Pubkey) -> Result<()> {
        require!(new_attestor != Pubkey::default(), CountyError::ZeroAttestor);
        let clock = Clock::get()?;
        let cfg = &mut ctx.accounts.config;
        let old = cfg.attestor;
        cfg.attestor = new_attestor;
        emit!(AttestorChanged {
            authority: ctx.accounts.authority.key(),
            old,
            new: new_attestor,
            slot: clock.slot,
            ts: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Step 1 of config-authority rotation. Current authority only; works while paused.
    /// Creates or overwrites the single PendingAuthority PDA (the authority pays rent).
    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        require!(new_authority != Pubkey::default(), CountyError::ZeroAuthority);
        require!(
            new_authority != ctx.accounts.config.authority,
            CountyError::SameAuthority
        );
        let clock = Clock::get()?;
        let pending = &mut ctx.accounts.pending;
        pending.proposed = new_authority;
        pending.proposer = ctx.accounts.authority.key();
        pending.bump = ctx.bumps.pending;
        emit!(AuthorityProposed {
            authority: ctx.accounts.authority.key(),
            proposed: new_authority,
            slot: clock.slot,
            ts: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Step 2. Must be signed by the proposed key (a normal signer, or a PDA such as a
    /// Squads vault signing via invoke_signed). Works while paused. Closes the pending
    /// account and returns its rent to the proposer who paid for it.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let clock = Clock::get()?;
        let cfg = &mut ctx.accounts.config;
        let old = cfg.authority;
        cfg.authority = ctx.accounts.new_authority.key();
        emit!(AuthorityChanged {
            old,
            new: cfg.authority,
            slot: clock.slot,
            ts: clock.unix_timestamp,
        });
        Ok(())
    }

    /// Current authority only; works while paused. Closes the pending account (rent to proposer).
    pub fn cancel_authority(ctx: Context<CancelAuthority>) -> Result<()> {
        let clock = Clock::get()?;
        emit!(AuthorityProposalCancelled {
            authority: ctx.accounts.authority.key(),
            proposed: ctx.accounts.pending.proposed,
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
/// Account layout version written by post_root_v2 / migrate_root.
/// 0 = legacy 98-byte account (no version byte), 1 = 99-byte account,
/// 2 = 256-byte account with the provenance/history tail (see OFF_* below).
/// The leaf recipe is signalled by `schema` (and leaf_version in the v2 tail), not by this byte.
pub const COUNTY_ROOT_VERSION: u8 = 2;
/// v2 = 256 bytes. Bytes 0..98 are the unchanged Borsh body; the tail is read by offset.
pub const COUNTY_ROOT_V2_LEN: usize = 256;
pub const OFF_VERSION: usize = 98;
pub const OFF_MANIFEST_SHA256: usize = 99;
pub const OFF_SOURCE_SHA256: usize = 131;
pub const OFF_PACKET_SHA256: usize = 163;
pub const OFF_DATA_AS_OF: usize = 195;
pub const OFF_FETCHED_AT: usize = 203;
pub const OFF_POSTED_SLOT: usize = 211;
pub const OFF_STATUS_CHANGED_AT: usize = 219;
pub const OFF_SUPERSEDED_BY: usize = 227;
pub const OFF_RETRACT_REASON: usize = 231;
pub const OFF_LEAF_VERSION: usize = 232;
pub const OFF_FLAGS: usize = 233;
pub const OFF_RESERVED: usize = 234;
pub const FLAG_MIGRATED: u8 = 1;
/// fetched_at holds a "fetched no later than" bound (commit or post time), not a recorded download time.
pub const FLAG_FETCHED_AT_IS_UPPER_BOUND: u8 = 2;

pub const REASON_NONE: u8 = 0;
pub const REASON_SUPERSEDED: u8 = 1;
pub const REASON_PII: u8 = 2;
pub const REASON_SOURCE_ERROR: u8 = 3;
pub const REASON_DUPLICATE: u8 = 4;
pub const REASON_BUILD_ERROR: u8 = 5;
pub const REASON_OTHER: u8 = 255;

/// CountyHead: 8 disc + fips 4 + latest_epoch 4 + latest_active_epoch 4 + n_epochs 4
/// + updated_at 8 + bump 1 = 33 bytes used, padded to 48 (15 reserved).
pub const COUNTY_HEAD_LEN: usize = 48;

/// Read a CountyRoot's version: 0 if the account is the legacy 98-byte layout.
pub fn county_root_version(info: &AccountInfo) -> Result<u8> {
    let data = info.try_borrow_data()?;
    Ok(if data.len() > COUNTY_ROOT_V0_LEN { data[COUNTY_ROOT_V0_LEN] } else { 0 })
}

pub const STATUS_ACTIVE: u8 = 1;
pub const STATUS_RETRACTED: u8 = 2;
/// Was valid; replaced by a later epoch (superseded_by in the v2 tail, or head.latest_epoch).
pub const STATUS_SUPERSEDED: u8 = 3;

/// Real county-equivalent FIPS: state 01..78, county 001..999 (state codes like 6000 rejected).
/// Devnet builds additionally accept 90000..=99999 for test counties.
pub fn valid_fips(fips: u32) -> bool {
    let real = (1001..=78999).contains(&fips) && fips % 1000 != 0 && fips <= 78030;
    real || (cfg!(feature = "devnet") && (90000..=99999).contains(&fips))
}

pub fn county_root_address(fips: u32, epoch: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"county_root".as_ref(), fips.to_le_bytes().as_ref(), epoch.to_le_bytes().as_ref()],
        &crate::ID,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Provenance {
    /// sha256 of the canonical manifest JSON bytes as published.
    pub manifest_sha256: [u8; 32],
    /// sha256 of the raw county download (all zero only for migrated roots whose raw file was not archived).
    pub source_sha256: [u8; 32],
    /// sha256 of the published packet CSV.
    pub packet_sha256: [u8; 32],
    /// County's own edit date (unix seconds), 0 if the county does not expose one.
    pub data_as_of: i64,
    /// When CountyRoot downloaded the extract (unix seconds, UTC).
    pub fetched_at: i64,
    /// Leaf recipe: 1 or 2.
    pub leaf_version: u8,
}

impl Provenance {
    fn common(&self) -> Result<()> {
        require!(self.manifest_sha256 != [0u8; 32], CountyError::ZeroHash);
        require!(self.packet_sha256 != [0u8; 32], CountyError::ZeroHash);
        require!(self.leaf_version == 1 || self.leaf_version == 2, CountyError::BadLeafVersion);
        require!(self.fetched_at > 0 && self.data_as_of >= 0, CountyError::BadDates);
        require!(self.data_as_of == 0 || self.data_as_of <= self.fetched_at, CountyError::BadDates);
        Ok(())
    }
    pub fn check(&self) -> Result<()> {
        self.common()?;
        require!(self.source_sha256 != [0u8; 32], CountyError::ZeroHash);
        Ok(())
    }
    /// Migrated roots may lack the raw download hash (decision D3).
    pub fn check_migrated(&self) -> Result<()> { self.common() }
}

fn write_provenance(d: &mut [u8], p: &Provenance) {
    d[OFF_MANIFEST_SHA256..OFF_MANIFEST_SHA256 + 32].copy_from_slice(&p.manifest_sha256);
    d[OFF_SOURCE_SHA256..OFF_SOURCE_SHA256 + 32].copy_from_slice(&p.source_sha256);
    d[OFF_PACKET_SHA256..OFF_PACKET_SHA256 + 32].copy_from_slice(&p.packet_sha256);
    d[OFF_DATA_AS_OF..OFF_DATA_AS_OF + 8].copy_from_slice(&p.data_as_of.to_le_bytes());
    d[OFF_FETCHED_AT..OFF_FETCHED_AT + 8].copy_from_slice(&p.fetched_at.to_le_bytes());
    d[OFF_LEAF_VERSION] = p.leaf_version;
}

/// Record superseded_by / time / reason in the v2 tail when the account has one.
fn write_superseded_tail(info: &AccountInfo, by: u32, ts: i64) -> Result<()> {
    let mut d = info.try_borrow_mut_data()?;
    if d.len() >= COUNTY_ROOT_V2_LEN {
        d[OFF_STATUS_CHANGED_AT..OFF_STATUS_CHANGED_AT + 8].copy_from_slice(&ts.to_le_bytes());
        d[OFF_SUPERSEDED_BY..OFF_SUPERSEDED_BY + 4].copy_from_slice(&by.to_le_bytes());
        d[OFF_RETRACT_REASON] = REASON_SUPERSEDED;
    }
    Ok(())
}

fn emit_head(h: &CountyHead, key: Pubkey, clock: &Clock) {
    emit!(HeadUpdated {
        county_head: key,
        fips: h.fips,
        latest_epoch: h.latest_epoch,
        latest_active_epoch: h.latest_active_epoch,
        n_epochs: h.n_epochs,
        slot: clock.slot,
        ts: clock.unix_timestamp,
    });
}

#[account]
pub struct CountyHead {
    pub fips: u32,
    pub latest_epoch: u32,
    /// 0 = no active root (latest was retracted).
    pub latest_active_epoch: u32,
    pub n_epochs: u32,
    pub updated_at: i64,
    pub bump: u8,
}

#[event]
pub struct RootPostedV2 {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub n_parcels: u64,
    pub merkle_root: [u8; 32],
    pub schema: [u8; 32],
    pub manifest_sha256: [u8; 32],
    pub source_sha256: [u8; 32],
    pub packet_sha256: [u8; 32],
    pub data_as_of: i64,
    pub fetched_at: i64,
    pub leaf_version: u8,
    /// Epoch marked SUPERSEDED by this post, 0 if none.
    pub superseded_epoch: u32,
    pub attestor: Pubkey,
    pub slot: u64,
    pub ts: i64,
    pub version: u8,
}

#[event]
pub struct RootSuperseded {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub superseded_by: u32,
    pub slot: u64,
    pub ts: i64,
}

#[event]
pub struct RootRetractedV2 {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub merkle_root: [u8; 32],
    pub prev_status: u8,
    pub reason: u8,
    pub attestor: Pubkey,
    pub slot: u64,
    pub ts: i64,
    pub version: u8,
}

#[event]
pub struct RootMigrated {
    pub county_root: Pubkey,
    pub fips: u32,
    pub epoch: u32,
    pub old_len: u32,
    pub manifest_sha256: [u8; 32],
    pub source_sha256: [u8; 32],
    pub packet_sha256: [u8; 32],
    pub data_as_of: i64,
    pub fetched_at: i64,
    pub leaf_version: u8,
    pub fetched_at_is_upper_bound: bool,
    pub attestor: Pubkey,
    pub slot: u64,
    pub ts: i64,
}

#[event]
pub struct HeadUpdated {
    pub county_head: Pubkey,
    pub fips: u32,
    pub latest_epoch: u32,
    pub latest_active_epoch: u32,
    pub n_epochs: u32,
    pub slot: u64,
    pub ts: i64,
}

#[derive(Accounts)]
#[instruction(fips: u32, epoch: u32)]
pub struct PostRootV2<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = attestor,
        space = COUNTY_HEAD_LEN,
        seeds = [b"county_head".as_ref(), fips.to_le_bytes().as_ref()],
        bump
    )]
    pub county_head: Account<'info, CountyHead>,
    #[account(
        init,
        payer = attestor,
        space = COUNTY_ROOT_V2_LEN,
        seeds = [b"county_root".as_ref(), fips.to_le_bytes().as_ref(), epoch.to_le_bytes().as_ref()],
        bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    /// Previous latest epoch; required when it is still ACTIVE (address checked in the handler).
    #[account(mut)]
    pub prev_root: Option<Account<'info, CountyRoot>>,
    #[account(mut)]
    pub attestor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RetractRootV2<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"county_root".as_ref(), county_root.fips.to_le_bytes().as_ref(), county_root.epoch.to_le_bytes().as_ref()],
        bump = county_root.bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    #[account(
        mut,
        seeds = [b"county_head".as_ref(), county_root.fips.to_le_bytes().as_ref()],
        bump = county_head.bump
    )]
    pub county_head: Account<'info, CountyHead>,
    pub attestor: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(fips: u32, latest_epoch: u32)]
pub struct InitHead<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = attestor,
        space = COUNTY_HEAD_LEN,
        seeds = [b"county_head".as_ref(), fips.to_le_bytes().as_ref()],
        bump
    )]
    pub county_head: Account<'info, CountyHead>,
    #[account(
        seeds = [b"county_root".as_ref(), fips.to_le_bytes().as_ref(), latest_epoch.to_le_bytes().as_ref()],
        bump = latest_root.bump
    )]
    pub latest_root: Account<'info, CountyRoot>,
    #[account(mut)]
    pub attestor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateRoot<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: owner checked here; discriminator, PDA address and status checked in the handler.
    #[account(mut, owner = crate::ID)]
    pub county_root: UncheckedAccount<'info>,
    #[account(mut)]
    pub attestor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MarkSuperseded<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"county_root".as_ref(), county_root.fips.to_le_bytes().as_ref(), county_root.epoch.to_le_bytes().as_ref()],
        bump = county_root.bump
    )]
    pub county_root: Account<'info, CountyRoot>,
    #[account(
        seeds = [b"county_head".as_ref(), county_root.fips.to_le_bytes().as_ref()],
        bump = county_head.bump
    )]
    pub county_head: Account<'info, CountyHead>,
    pub attestor: Signer<'info>,
}

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

#[event]
pub struct AttestorChanged {
    pub authority: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
    pub slot: u64,
    pub ts: i64,
}

#[derive(Accounts)]
pub struct SetAttestor<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ CountyError::BadAuthority
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[account]
pub struct PendingAuthority {
    pub proposed: Pubkey,
    pub proposer: Pubkey,
    pub bump: u8,
}

pub const PENDING_AUTHORITY_LEN: usize = 8 + 32 + 32 + 1;

#[event]
pub struct AuthorityProposed {
    pub authority: Pubkey,
    pub proposed: Pubkey,
    pub slot: u64,
    pub ts: i64,
}

#[event]
pub struct AuthorityChanged {
    pub old: Pubkey,
    pub new: Pubkey,
    pub slot: u64,
    pub ts: i64,
}

#[event]
pub struct AuthorityProposalCancelled {
    pub authority: Pubkey,
    pub proposed: Pubkey,
    pub slot: u64,
    pub ts: i64,
}

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ CountyError::BadAuthority
    )]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = authority,
        space = PENDING_AUTHORITY_LEN,
        seeds = [b"pending_authority"],
        bump
    )]
    pub pending: Account<'info, PendingAuthority>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = proposer,
        seeds = [b"pending_authority"],
        bump = pending.bump,
        has_one = proposer,
        constraint = pending.proposed == new_authority.key() @ CountyError::WrongPendingAuthority,
        constraint = pending.proposer == config.authority @ CountyError::StaleProposal
    )]
    pub pending: Account<'info, PendingAuthority>,
    /// CHECK: rent destination; must equal pending.proposer (has_one).
    #[account(mut)]
    pub proposer: UncheckedAccount<'info>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelAuthority<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ CountyError::BadAuthority
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = proposer,
        seeds = [b"pending_authority"],
        bump = pending.bump,
        has_one = proposer
    )]
    pub pending: Account<'info, PendingAuthority>,
    /// CHECK: rent destination; must equal pending.proposer (has_one).
    #[account(mut)]
    pub proposer: UncheckedAccount<'info>,
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
    #[msg("Attestor cannot be the default (zero) pubkey")]
    ZeroAttestor,
    #[msg("Authority cannot be the default (zero) pubkey")]
    ZeroAuthority,
    #[msg("Proposed authority is already the authority")]
    SameAuthority,
    #[msg("Signer is not the proposed authority")]
    WrongPendingAuthority,
    #[msg("Proposal was made by a previous authority")]
    StaleProposal,
    #[msg("Instruction is deprecated; use the _v2 instruction")]
    Deprecated,
    #[msg("Migration instructions are only available in the devnet build")]
    DevnetOnly,
    #[msg("FIPS code is not a valid county code")]
    BadFips,
    #[msg("Epoch must be exactly head.latest_epoch + 1")]
    EpochNotNext,
    #[msg("County head does not match this FIPS")]
    HeadMismatch,
    #[msg("The previous latest epoch is ACTIVE and must be passed as prev_root")]
    PrevRootRequired,
    #[msg("Account is not the expected CountyRoot PDA")]
    PrevRootMismatch,
    #[msg("Provenance hashes cannot be zero")]
    ZeroHash,
    #[msg("leaf_version must be 1 or 2")]
    BadLeafVersion,
    #[msg("Provenance dates are invalid")]
    BadDates,
    #[msg("Retraction reason is not allowed")]
    BadReason,
    #[msg("Root is already retracted")]
    AlreadyRetracted,
    #[msg("Root is already in the v2 layout")]
    AlreadyMigrated,
    #[msg("Root is the latest epoch")]
    IsLatest,
    #[msg("superseded_by must be after this epoch and no later than the latest epoch")]
    BadSupersededBy,
}
