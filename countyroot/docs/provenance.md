# Provenance, history and the v2 account layout

Program v2 records where each root came from and keeps a county's history explicit.

- **`post_root_v2`** creates a 256-byte `CountyRoot` with a provenance tail. The tail holds:
  - `manifest_sha256`, `source_sha256`, `packet_sha256`
  - `data_as_of`, `fetched_at`, `posted_slot`, `leaf_version`
  - `flags` (bit 0 = migrated, bit 1 = `FETCHED_AT_IS_UPPER_BOUND`: `fetched_at` is a "no later than" bound, not the fetch time), `superseded_by`, `retract_reason`, `status_changed_at`
- **`post_root_v2`** for epoch N > 1 marks epoch N-1 `SUPERSEDED` (status 3) in the same transaction.
- **`CountyHead`** (PDA `["county_head", fips_le]`, 48 bytes) stores `latest_epoch`, `latest_active_epoch` and `n_epochs`.
  - Integrators read the head to answer "what is current".
  - **`retract_root_v2`** on the latest epoch sets `latest_active_epoch = 0`. Nothing falls back to an older root silently.
- **`update_root`, `post_root` and `retract_root`** stay in the IDL only as stubs that always fail with `Deprecated`. `update_root` can no longer rewrite a root.
- **`SUPERSEDED`** is a valid *historical* proof:
  - The CLI prints a warning and still passes.
  - The web verifier returns `current: false`.
  - `RETRACTED` or an unknown status fails.
- **The manifest** `<key>.<fips5>.e<N>.manifest.json` (key = the county part of the label before " / ", with anything outside `[A-Za-z0-9._-]` replaced by `_`; e.g. `Adams.CO / Aurora` fips 8001 -> `Adams.CO.08001.e2.manifest.json`; `manifests` refuses duplicate names or FIPS, and `run` matches files by FIPS) is canonical JSON: keys sorted, no whitespace, trailing LF.
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

If a county's latest epoch is retracted (decision D5), that epoch is left as it is (no `migrate_root`). `init_head` gives the county a head with `latest_active_epoch = 0`, and each older ACTIVE epoch is marked superseded by the retracted latest. The county then has no active root, and `fetchLatest` returns `{ epoch: 0, root: null }`.

### Dates in the manifests (`--meta`)

`scripts/build_meta.py --root <data dir> --out <meta.json>` writes the `--meta` file from the build records. Write it outside `public/`. It records each county's source URL and query, `fetched_at` and `data_as_of`, and which file each date came from. No date is estimated:
- `fetched_at` comes from the mtime of the exact packet CSV (sha256 checked) inside a build archive. A zip time is used only when a git commit pins its time zone.
- A batch note such as "pulled 2026-10-14" gives only a day. It goes in `fetched_on`, and `fetched_at` stays null.
- Lookback (added to meta.json by hand review, not by `build_meta.py`): a county with no real fetch time gets `fetched_no_later_than` (the earliest commit time of the script that posted its root, or the on-chain post time), with `fetched_no_later_than_source` naming the evidence.
- `migrate_v2.mjs manifests` uses `fetched_at` when there is one (flag clear, `fetched_at_is_upper_bound: false`). Otherwise it puts `fetched_no_later_than` in `fetched_at` and sets `fetched_at_is_upper_bound: true`, passed to `migrate_root` so the program sets flag bit 1. The manifest keeps `fetched_at_source` and the day-only `fetched_on`. These three manifest keys are optional; `verifyManifest` checks the boolean against the on-chain bit (absent = false). A county with neither is refused.
- SDK 0.3.0 exposes `provenance.fetchedAtIsUpperBound` (web: `fetchedAtIsUpperBound`, `fetchedAtText`); the CLI and web show "fetched no later than <time>" for flagged roots and "fetched <time>" otherwise. Re-running the migration on an already-migrated root fails if the on-chain bit differs from the manifest.

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
