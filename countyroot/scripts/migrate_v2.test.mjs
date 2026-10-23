// node --test scripts/migrate_v2.test.mjs   (SDK built). Offline; the end-to-end run is scripts/rehearse_migration.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadSdk } from "./verify.mjs";
import { piiGuard, main } from "./migrate_v2.mjs";

const sdk = await loadSdk();
const good = () => ({
  county_label: "Travis County, TX", fips: 48453, epoch: 2, source_url: "https://example.gov/data/parcels.zip", source_query: null,
  source_format: "shapefile", fetched_at: "2026-10-01T12:00:00Z", source_sha256: null, source_record_count: null, data_as_of: null,
  builder_commit: "abc1234", recipe: "leaf-v2", leaf_version: 2, schema_sha256: "aa".repeat(32), packet_sha256: "bb".repeat(32),
  pii_scan: { result: "pass", tool: "scripts/verify.mjs" }, n_parcels: 10, merkle_root: "cc".repeat(32), supersedes_epoch: 1, reason: "migrated",
});

test("piiGuard accepts a county-level manifest", () => { piiGuard(sdk, good()); });
test("piiGuard rejects personal data and stray keys", () => {
  for (const [k, v, re] of [
    ["county_label", "jane@example.com", /email/], ["source_query", "123 Main St", /street address/], ["builder_commit", "(512) 555-0100", /phone/],
    ["recipe", "123-45-6789", /SSN|phone/], ["source_query", { owner: "x" }, /object/],
  ]) assert.throws(() => piiGuard(sdk, { ...good(), [k]: v }), re, `${k}=${JSON.stringify(v)}`);
  assert.throws(() => piiGuard(sdk, { ...good(), owner_name: "x" }), /allow-list: owner_name/);
  const m = good(); delete m.reason; assert.throws(() => piiGuard(sdk, m), /missing keys: reason/);
  assert.throws(() => piiGuard(sdk, { ...good(), fetched_at: null }), /fetched_at/);
  assert.throws(() => piiGuard(sdk, { ...good(), data_as_of: "2026-11-01T00:00:00Z" }), /after fetched_at/);
});
test("refuses mainnet and unknown commands", async () => {
  const out = []; const log = (s) => out.push(s);
  assert.equal(await main(["run", "--manifests", "/nonexistent", "--cluster", "mainnet"], { log }), 2);
  assert.match(out.at(-1), /Devnet-only/);
  assert.equal(await main(["run", "--manifests", "/x", "--cluster", "https://api.mainnet-beta.solana.com"], { log }), 2);
  assert.equal(await main(["post"], { log }), 2);
});
