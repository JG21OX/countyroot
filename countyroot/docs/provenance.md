# Provenance, history and the v2 account layout

Program v2 records where each root came from and keeps a county's history explicit.

- **`post_root_v2`** creates a 256-byte `CountyRoot` with a provenance tail. The tail holds:
  - `manifest_sha256`, `source_sha256`, `packet_sha256`
  - `data_as_of`, `fetched_at`, `posted_slot`, `leaf_version`
  - `flags` (bit 0 = migrated), `superseded_by`, `retract_reason`, `status_changed_at`
- **`post_root_v2`** for epoch N > 1 marks epoch N-1 `SUPERSEDED` (status 3) in the same transaction.
- **`CountyHead`** (PDA `["county_head", fips_le]`, 48 bytes) stores `latest_epoch`, `latest_active_epoch` and `n_epochs`.
  - Integrators read the head to answer "what is current".
  - **`retract_root_v2`** on the latest epoch sets `latest_active_epoch = 0`. Nothing falls back to an older root silently.
- **`update_root`, `post_root` and `retract_root`** stay in the IDL only as stubs that always fail with `Deprecated`. `update_root` can no longer rewrite a root.
- **`SUPERSEDED`** is a valid *historical* proof:
  - The CLI prints a warning and still passes.
  - The web verifier returns `current: false`.
  - `RETRACTED` or an unknown status fails.
- **The manifest** `<label>.e<N>.manifest.json` is canonical JSON: keys sorted, no whitespace, trailing LF.
  - It holds county-level metadata only. The key allow-list is `MANIFEST_KEYS` in the SDK.
  - It has no parcel rows, owner names or site addresses, and nothing is hashed from them.
  - Check it with `verifyManifest(bytes, account)`.

## Builds

`bash scripts/build-programs.sh` produces:
- `target/deploy/countyroot-devnet.so` (feature `devnet`). This build has the one-time migration instructions and accepts test FIPS 90000–99999.
- `target/deploy/countyroot.so` (Mainnet). Its migration instructions return `DevnetOnly`, and it accepts real FIPS 1001–78030 only.

## Devnet migration (one time)

Per county, `scripts/migrate_v2.mjs` sends one transaction with the steps below. Re-runs skip finished work.
1. `migrate_root` on the latest epoch. This reallocates 99 to 256 bytes, sets the migrated flag and stores a zero `source_sha256`.
2. `init_head`.
3. `mark_superseded` for each older ACTIVE epoch.

If a county's latest epoch is retracted, it is reported and skipped, so it gets no head.

The migration instructions refuse while the program is paused. The order is:
1. pause
2. deploy
3. unpause
4. migrate

`node scripts/rehearse_migration.mjs` runs the whole flow on a local `solana-test-validator`.

## Rent (5,080 lamports/byte incl. the 128-byte header; `solana rent <bytes>`)

| account | bytes | SOL |
|---|---|---|
| CountyRoot v1 | 99 | 0.00115316 |
| CountyRoot v2 | 256 | 0.00195072 |
| CountyHead | 48 | 0.00089408 |
| realloc 99 to 256 | +157 | 0.00079756 |
