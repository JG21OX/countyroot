# Verify a parcel (countyroot.com/verify)

A static page that checks one parcel against its county's CountyRoot root, in the browser, without downloading the
whole parcel list. No third-party JavaScript; it runs under the site CSP (`script-src 'self'`).

Files: `verify.html` (served as `/verify/index.html`), `verify.js` (page), `cr-verify.js` (leaf/tree/proof/account code,
a byte-for-byte port of the SDK's v1 rules, using WebCrypto). The site build (`site/gen/build_site.py`) copies them and
writes `/verify/counties.json` (each county's current epoch, PDA and published root from root.json) and
`/verify/config.json` (RPC and packet host).

## Proof sidecar files (`scripts/build_proofs.mjs`)
For each packet `<label>/<label>.<epoch>.<month>.csv` on R2, the proofs live next to it in `<label>.<epoch>.<month>.proofs/`:

| File | What | Size |
|---|---|---|
| `index.json` | layout (chunk size, shard count, n_parcels, root); untrusted | < 1 KB |
| `s/<k>.json` | rows whose ID hashes to shard k: `[parcel_id, acres, lot_sqft, leaf_index]` | ≤ 100 KB |
| `c/<k>.bin` | 2,048 leaf hashes (32 bytes each) | 64 KB |
| `top.bin` | tree levels from the chunk roots up to the root | ~n/32 bytes |

A lookup is 4 fetches: index, one shard, one chunk, top (about 150–250 KB in total). Shard = first 4 bytes of
`sha256(upper(trim(parcel_id)))` mod `n_shards`, so the search ignores case and surrounding spaces. Duplicate parcel
IDs (e.g. Miami-Dade) are all returned, each with its own row and proof. The builder refuses a packet unless its CSV
rebuilds root.json, passes the parcel-ID personal-info check, and (with `--rpc`, the default) matches an ACTIVE
on-chain account, and it compares every assembled proof with the SDK's before writing anything.

```
node scripts/build_proofs.mjs --csv X.csv [--root X.root.json] --out <stage dir> --sample all
node scripts/scan_proofs.mjs --dir <stage dir> [--forbid-ids-from old.csv --except-ids-from new.csv]
node scripts/proof_upload_list.mjs --dir <stage dir>      # writes upload-list.txt and upload.sh (does not upload)
```

## Trust model
- **Proof files are untrusted.** The page recomputes the leaf from the row and hashes up to a root; any changed byte in
  a row, chunk or top file gives a different root and the check fails.
- **The root comes from Solana.** The page reads the county's PDA from the Devnet RPC at `finalized`, requires owner =
  CountyRoot program, the CountyRoot discriminator, matching fips/epoch, status ACTIVE and `n_parcels` equal to the proof's leaf
  count, then compares roots. (The browser doesn't derive the PDA, since it has no ed25519 library, but it doesn't need to:
  only the program can write an account it owns, and `post_root` writes fips/epoch from its seeds.) You still trust the RPC
  node's answer. Open the Explorer link to cross-check.
- **Fallback:** if the RPC can't be reached, the page compares with the root published in `/verify/counties.json`
  (baked in from root.json at site build time) and says so in an amber banner. That only proves the row matches what the
  site publishes, so confirm on Explorer.
- **You trust the page code itself** (served by countyroot.com). For a check that relies on nothing from the site,
  use the SDK CLI: `countyroot verify --root X.root.json --csv X.csv --parcel <id> --rpc devnet`. The page offers each
  verified proof as a download in the SDK's proof format.

## Hosting choice
Proof files stay on R2 next to the packets (`packets.countyroot.com`), not on Cloudflare Pages: all 212 counties need
about 62,000 files (≈4 GB), above the Pages file limit (20,000 per site on the Free plan), and proofs belong with the packets they prove.
So the CSP adds `connect-src https://packets.countyroot.com https://api.devnet.solana.com`, and the R2 bucket needs a
GET/HEAD CORS rule for countyroot.com (`r2-cors.json`). The Devnet RPC already sends CORS headers for countyroot.com.

## Tests
- `node --test scripts/build_proofs.test.mjs` covers the builder/verifier against the SDK (every leaf for n = 1..70 across
  chunk sizes, duplicates, tampering, fallback, account decoding, the PII scan). Set
  `COUNTYROOT_PROOF_PACKETS=a.csv:b.csv` to check every row of real packets.
- `node --experimental-websocket --test verifier/test/` is the headless Chrome test of the built page under the real CSP,
  against a local server (mock RPC, plus one case proxied to the real Devnet RPC).
