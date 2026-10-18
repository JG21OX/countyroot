# CountyRoot fingerprint (leaf) format v2: spec, on-chain impact, migration

Status: Phase 1 (design + prototype). Nothing posted, uploaded, deployed or merged.
Prototype: branch `leaf-v2` (JG21OX/countyroot), files `sdk/src/leafv2.ts`, `scripts/build_v2.mjs`, `verifier/cr-verify.js` (v2 section), `verifier/verify.js`, `sdk/src/cli.ts` (v2 verify), tests in `sdk/test/leafv2.test.ts`, `scripts/build_v2.test.mjs`, `verifier/test/page.test.mjs`.
Date: 2026-10-18.

## 1. What v1 gets wrong (from the 2026-10-17 competitor review)

| Problem | Evidence |
|---|---|
| Leaf hashes decimal *text* | Travis e1 wrote `18089`, e2 wrote `18089.00`: 386,068 of 386,068 leaves differ while the data changed 0% |
| No domain separation | leaf = sha256(text), node = sha256(l‖r): a 64-byte leaf text could be read as a node; a leaf means the same thing in any county |
| No county/epoch binding | a proof only means something next to a root.json; the leaf itself is county-less |
| Leaf count is self-reported | the odd-level "duplicate last node" rule lets a phantom index n verify with leafCount n+1 unless the caller checks n_parcels |
| CSV order | no non-membership proofs ("this APN is not in the roll"); lookups need a hash index |
| Duplicate IDs | MiamiDade e2: 1,193 repeated-ID rows (one folio 87 times); Suffolk.MA: 319. The CLI proves "the first match" |
| Position-based IDs | `UNNUMBERED-<CSV line>` (Osage 1 row, EBR 2 rows) changes whenever rows move |

## 2. The v2 spec (normative)

All integers little-endian (same as the PDA seeds and Borsh). Hash = SHA-256 everywhere.

### 2.1 Fields

- **fips**: u32, the county FIPS.
- **id**: the county's parcel ID string **exactly as published** (after trimming outer spaces), printable ASCII 0x20–0x7E, 1–256 bytes. The builder refuses anything else. All 53,406,942 rows in today's 212 packets already qualify: all ASCII, no outer spaces, longest 39 bytes.
- **key(id)**, the normalized key. It is not stored in the leaf; it is derived the same way everywhere:
  - ASCII upper-case;
  - remove space, tab, `.` and `-`;
  - strip leading `0`s, keeping at least one character;
  - if that leaves an empty string, use the upper-cased id.

  This is the same rule as the live verifier's `normKey`, so `0240050817` → `240050817` and `12601-01-01` → `126010101`.
- **occ**: u32, the occurrence number among rows with the *same exact id*. It is 0 for unique IDs. Rows sharing an id are ordered by (acres_micro, sqft_centi) and numbered 0, 1, 2…, so the CSV order never matters.
- **acres_micro**: u64, acres × 10^6. **sqft_centi**: u64, lot square feet × 100.
  - Both are converted from the decimal string **exactly** (integer arithmetic, no floats) and rounded half-up at the 6th or 2nd decimal place. These are the same precision and rounding as v1's text, so v1 → v2 is lossless and `18089`, `18089.0` and `18089.00` all give 1,808,900.
  - Negative or exponent notation is refused.
  - `u64::MAX` means "not provided". No current row needs it: there are no blanks.
  - Maximums today: 3.1e13 micro-acres and 1.35e14 centi-sqft. Both are below 2^53, so they are also exact as JSON numbers.

Why micro-acres and centi-sqft:
- They are exactly v1's precision, so no data is lost and no rounding moves.
- Integers can't drift in formatting.
- Whole square feet would throw away the 2 decimal places that packets carry.

lot_sqft is in fact acres × 43,560 to 2dp in every packet sampled (40 counties, 200k rows, all within 0.03 sq ft). Keeping it costs 8 bytes per leaf and keeps room for sources that give lot size independently.

### 2.2 Hashes

```
leaf = SHA256( 0x00 || "countyroot/leaf/v2" || u32 fips || u16 len(id) || id || u32 occ || u64 acres_micro || u64 sqft_centi )
node = SHA256( 0x01 || left || right )
       the last node of an odd level is promoted unchanged (no duplication)
root = SHA256( 0x02 || "countyroot/root/v2" || u32 fips || u32 epoch || u64 n_leaves || top )
```

- **Domain separation.** The leaf, node and root have different prefix bytes and tags, so none can be passed off as another.
- **fips is in the leaf.** A leaf or proof from one county never verifies in another county.
- **epoch and n_leaves are in the root, not the leaf.**
  - So an unchanged parcel keeps the *same leaf in every epoch*, which makes epoch diffs meaningful (item 7).
  - A proof still only verifies against its own epoch's root.
  - Binding n_leaves removes the phantom-leaf issue, and with promotion instead of duplication there is no "pair with itself" ambiguity at all.
- **Schema id:**
  - The id string is `SCHEMA_V2_ID` in `sdk/src/leafv2.ts`.
  - **SCHEMA_V2 = sha256(SCHEMA_V2_ID) = `b309043c77b9aa529244033ecbcaa030615fa949993c835bade21fd2abfbf00d`**.
  - For comparison, v1 = `1b0a0a99…a427`, which all 212 live accounts carry.

### 2.3 Order and proofs

- **Leaf order.** Leaves are sorted by (key bytes, id bytes, occ), a strict total order.
- **Membership proof.** It contains the leaf's fields, its index, n_leaves, fips, epoch, and one sibling per level where the node has a partner (none where it is promoted).
- **Non-membership of a normalized key q.** The proof is the two adjacent leaves L_i and L_{i+1} with key(L_i) < q < key(L_{i+1}), both proven and with consecutive indices. At the ends it is just L_0 with q < key(L_0), or L_{n-1} with q > key(L_{n-1}). Because n_leaves is bound in the root, "last leaf" can't be faked.
- **What absence means.** It is proven for the *normalized* key, which is what people type.
- **Shared keys.** 48,284 IDs in 29 counties share a key with a different ID. Tarrant has 18,542, e.g. lot-block styles that normalize alike; others include Alameda 13,573 and Brown.WI 11,356. Those are all kept, sit next to each other, and a lookup returns every candidate.
- **Sortedness is a property of the posted root.** Anyone holding the packet can check it. The builder refuses unsorted input (`buildTreeV2`).

### 2.4 Hash function

Keep SHA-256:
- It is native in browsers (WebCrypto), Node, Rust and Python.
- Solana has a syscall for it (`sol_sha256`, about 85 CU base plus 1 CU per 2 bytes). A depth-22 proof (LA, 2.4M leaves) costs about 23 node hashes ≈ 3k CU in a future CPI verifier (item 5).
- Keccak has the same syscall cost and no advantage for us.
- Poseidon is only worth it for ZK circuits, which aren't planned.

A CPI proof for LA is 22 × 32 B of siblings plus ~70 B of leaf data. It fits a transaction but is tight with the caller's own accounts; item 5 should document a buffer account or ALT pattern.

### 2.5 Stable IDs instead of `UNNUMBERED-<line>`

This affects only 3 rows today (Osage.OK 1, EastBatonRouge.LA 2). They are rows whose source parcel number was a personal name or empty and was redacted. Options:

| Option | Stable across epochs? | Privacy |
|---|---|---|
| **(a) Geometry hash** (chosen): `NOID-` + first 16 hex of `sha256("countyroot/geom/v1" ‖ 0x00 ‖ u32 fips ‖ canonical geometry text)` (rule below) | Yes, while the shape is unchanged. A resurvey gives a new ID, which is arguably a new parcel. | A parcel outline is public GIS, not data about a person. Anyone can recompute it, which is the point. |
| (b) Source fallback key (OBJECTID/GlobalID): `SRC-<id>` | Only if the source keeps it. OBJECTIDs often renumber on republish. | Fine. |
| (c) Hash of other attributes | Fragile | **Never hash names, owners, mailing or situs addresses.** They are low-entropy, so a hash is reversible by dictionary and is effectively disclosure. |

Decided: (a), with (b) only when a row has no geometry. Implemented in `scripts/noid.py` (reference, used by the
packet builder) and checked by `scripts/build_v2.mjs` (`noidOf`, which re-hashes every replacement from its
canonical geometry before building).

**NOID rule (`countyroot/geom/v1`)**

    NOID-<first 16 hex digits, upper case, of sha256("countyroot/geom/v1" || 0x00 || u32le fips || canonical_geometry)>

`canonical_geometry` is ASCII text built from the source's public parcel outline only:

1. Request the feature's geometry from the official source in WGS84 (`outSR=4326`).
2. Each vertex becomes integers `(round(lon * 1e7), round(lat * 1e7))` (1e-7 degree, about 1 cm).
3. Each ring: drop consecutive duplicate vertices and the closing vertex; orient exterior rings counter-clockwise
   and holes clockwise (shoelace sign on the integers); rotate so the ring starts at its smallest `(x, y)`.
4. Group rings into polygons (an exterior ring and the holes the source lists after it); sort the holes in a
   polygon, then the polygons, by their text.
5. Ring text `x y,x y,...`; a polygon is its rings joined by `/` (exterior first); the geometry is its polygons
   joined by `;`.

64 bits: the chance of a collision inside the largest county (2.4M parcels) is about 1.6e-7, and the builder
refuses duplicates anyway. The NOID is stable while the outline is unchanged. Names, owners and addresses are never
hashed or kept: the original ID is used only once, in memory, to find the source feature, and is never printed or
written.

The v2 root.json records each replacement (`id_replacements`: old ID, NOID, source layer, source object ID and the
sha256 of the canonical geometry), so anyone can re-fetch the outline and recompute the NOID.

Result for the 3 rows (each matched exactly one source feature; its outline area agrees with the packet's lot size
to better than 3e-5):

| County | Old ID | NOID | Source object |
|---|---|---|---|
| Osage.OK (40113) | UNNUMBERED-41938 | NOID-FF56C03DE20FF661 | INCOG Parcels_OsageCo OBJECTID 16541 |
| EastBatonRouge.LA (22033) | UNNUMBERED-200154 | NOID-606909389DF132DB | EBR Tax_Parcel ID 189343 |
| EastBatonRouge.LA (22033) | UNNUMBERED-200156 | NOID-9C043A41FF95D41F | EBR Tax_Parcel ID 193562 |

The v1 epochs keep `UNNUMBERED-<line>` (their roots are on-chain); the NOIDs appear from the v2 epoch on.

## 3. On-chain impact

- **No program upgrade is needed.**
  - `post_root(fips, epoch, n_parcels, merkle_root, schema)` accepts any 32-byte `schema`. v2 roots are posted with `schema = SCHEMA_V2`, and verifiers dispatch on it.
  - `n_parcels` = n_leaves (rows, as in v1).
  - PDA seeds don't change, so v2 goes in a new epoch account.
- **Version byte.** It stays 1 for v2 accounts: it describes the *account layout* (99 bytes), which doesn't change. The program comment calls it "layout/leaf-recipe version". Documentation, SDK and verifier treat **schema** as the leaf-recipe signal.
  - Optional one-line change for later: write version 2 when schema == SCHEMA_V2. Fold it into the program v2 work (item 4: latest-epoch pointer, SUPERSEDED status, manifest hash) before Mainnet rather than upgrading just for this.
- **v1 and v2 coexist.** Different epochs of the same county can use different formats. The verifier refuses v2 files against a v1-schema account and v1 files against a v2-schema account.
- **Not recommended: `update_root` in place.** It would avoid new rent, but it rewrites history and breaks the existing v1 proofs and links.
- **Superseded, not retracted.**
  - The program has only ACTIVE/RETRACTED.
  - `close_root` requires RETRACTED, so v1 accounts stay ACTIVE and keep their rent (0.243 SOL total).
  - They are marked superseded *off-chain*: `counties.json` gets `superseded_by`, and the site and verifier show "superseded by epoch N+1 (format v2)".
  - An on-chain SUPERSEDED status or latest pointer is item 4.

## 4. Migration (212 counties)

1. **Merge `leaf-v2`** after review. Port the v2 builder rules into the packet pipeline (item 9) so new packets are emitted v2-native.
2. **Build.** For each county, take the current packet, run the existing v1 checks (root rebuild = root.json, personal-info check, on-chain ACTIVE), then produce:
   - the v2 root at epoch N+1. The prototype does this (`scripts/build_v2.mjs`); for the current set, 201 counties go 1 → 2 and 11 go 2 → 3.
   - **Recommended:** a v2 packet CSV in leaf order with integer columns (`parcel_id,occ,acres_micro,sqft_centi,leaf`), so the CSV line equals the leaf index and nobody has to re-sort.
   - root.json with `schema_sha256` and `leaf_version: 2`.
3. **Post.** You run it on the Mac: `post_root(fips, N+1, n, root_v2, SCHEMA_V2)` × 212 with the existing batch scripts.
   - Rent is 0.00115316 SOL per 99-byte account × 212 = **0.2445 SOL**.
   - Fees are 212 × 5,000 lamports = 0.0011 SOL, so **≈ 0.246 SOL in total**.
   - That is free on Devnet (airdrop); on Mainnet it is the same amount of SOL.
   - The v1 accounts are untouched.
4. **Proof files, format 2.** Upload with the rclone kit, run by you.
   - Layout: `index.json`, `f.json` (fences: the first key of each chunk), `r/<k>.json` (rows of chunk k), `c/<k>.bin`, `top.bin`, and optional `x/` for county aliases. Sorting removes the separate shard, normalized-ID and suffix indexes.
   - With 1,024-leaf chunks every file is ≤ 40 KB.
   - Travis is 759 files / 24 MB in v2, against 815 / 43 MB in v1. The all-county estimate is about 105k files / about 3 GB. With 2,048-leaf chunks it would be about 53k files and ≤ 80 KB per file.
5. **Site and verifier.**
   - `counties.json` lists the latest epoch (v2) plus older epochs with `superseded_by`.
   - The page already dispatches on `index.json` format: format 2 means the v2 path with absence proofs.
   - Old epochs stay verifiable from the archive links (small UI addition: `?c=<label>&e=<epoch>`).
6. **SDK.**
   - `leafHashV2`, `buildTreeV2`, `makeProofV2`, `verifyProofV2`, `makeAbsenceProofV2` and `verifyAbsenceV2` are exported.
   - The CLI `verify` accepts v2 proofs and checks that the on-chain schema is v2.
   - v1 functions are unchanged.
7. **Epoch diffs (item 7)** come for free: same leaf means unchanged.

## 5. Prototype results (local only)

| County | v1 epoch → v2 epoch | Leaves | v2 root | Notes |
|---|---|---|---|---|
| Travis.TX | 2 → 3 | 386,068 | `95dd52e5…a3b8` | e1 vs e2 under v2: **386,068 unchanged, 0 changed, 0 added, 0 removed** (v1: 0 of 386,068 leaves equal) |
| MiamiDade.FL | 2 → 3 | 119,392 | `2024c8ec…4565` | 1,193 rows with occ > 0; 118,199 distinct IDs; folio 3069340218780 = 87 leaves, occ 0–86, all prove |
| Osage.OK | 2 → 3 | 41,941 | `19c34a20…d8f3` | 2 IDs share a key with another ID |
| EastBatonRouge.LA | 2 → 3 | 200,164 | `1d645af1…aeca3` | |
| Martin.TX (smallest) | 1 → 2 | 6,695 | `174b16f4…1620` | used in the browser tests |


## 6. Decisions needed

1. **Duplicate IDs:** one leaf per row with `occ` (prototype), or one leaf per ID with the rows grouped inside it. Per-row is simpler and keeps the count equal to rows; grouping makes "the parcel" one leaf but changes the meaning of n.
2. **Epoch bound in the root, not the leaf**, so unchanged parcels keep identical leaves across epochs (the point of fixing the Travis bug). The alternative binds epoch in the leaf and loses leaf-level diffs.
3. **No program upgrade now** (schema = SCHEMA_V2, version byte stays 1). Do the version-byte, SUPERSEDED and latest-pointer changes once, together with item 4, before Mainnet.
4. **UNNUMBERED replacement:** geometry hash (chosen; see 2.5).
5. **Publish v2 packets** sorted with integer columns (recommended) or keep the v1-style CSV and sort on the fly.
