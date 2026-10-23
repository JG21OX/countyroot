// node --test scripts/migrate_v2.test.mjs   (SDK built). Offline; the end-to-end run is scripts/rehearse_migration.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { loadSdk } from "./verify.mjs";
import { piiGuard, main, migrateRootIx } from "./migrate_v2.mjs";
import fs from "node:fs";

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

// ---- planCounty against a mocked connection (legacy 98-byte accounts, as the old program wrote them)
import { planCounty } from "./migrate_v2.mjs";
import { Keypair } from "@solana/web3.js";
const legacy = (fips, epoch, status, m) => {
  const d = Buffer.alloc(98); sdk.discriminator("account:CountyRoot").copy(d, 0);
  d.writeUInt32LE(fips, 8); d.writeUInt32LE(epoch, 12); d.writeBigUInt64LE(BigInt(m.n_parcels), 16);
  Buffer.from(m.merkle_root, "hex").copy(d, 24); Buffer.from(m.schema_sha256, "hex").copy(d, 56); d[88] = status; return d;
};
const headData = (fips, latest, active) => {
  const d = Buffer.alloc(41); sdk.discriminator("account:CountyHead").copy(d, 0);
  d.writeUInt32LE(fips, 8); d.writeUInt32LE(latest, 12); d.writeUInt32LE(active, 16); d.writeUInt32LE(latest, 20); return d;
};
const conn = (accts) => ({ getAccountInfo: async (k) => (accts.has(k.toBase58()) ? { owner: sdk.PROGRAM_ID, data: accts.get(k.toBase58()) } : null) });
const county = (statuses, head) => {
  const m = good(); m.epoch = statuses.length; const a = new Map();
  statuses.forEach((s, i) => a.set(sdk.countyRootPda(m.fips, i + 1).toBase58(), legacy(m.fips, i + 1, s, m)));
  if (head) a.set(sdk.countyHeadPda(m.fips).toBase58(), headData(m.fips, ...head));
  return { bytes: sdk.canonicalManifest(m), c: conn(a) };
};
const att = Keypair.generate().publicKey;

test("plan: newest epoch ACTIVE -> migrate_root + init_head + mark_superseded", async () => {
  const { bytes, c } = county([sdk.STATUS_ACTIVE, sdk.STATUS_ACTIVE]);
  const p = await planCounty(sdk, c, bytes, att);
  assert.deepEqual(p.steps.map((s) => s.op), ["migrate_root", "init_head", "mark_superseded"]);
  assert.equal(p.noActiveRoot, undefined);
});
test("plan: newest epoch RETRACTED -> init_head (no active root) + supersede older ACTIVE, no migrate_root (D5)", async () => {
  const { bytes, c } = county([sdk.STATUS_ACTIVE, sdk.STATUS_RETRACTED]);
  const p = await planCounty(sdk, c, bytes, att);
  assert.deepEqual(p.steps, [{ op: "init_head", epoch: 2 }, { op: "mark_superseded", epoch: 1, by: 2 }]);
  assert.equal(p.ixs.length, 2); assert.equal(p.noActiveRoot, true); assert.equal(p.skip, undefined);
});
test("plan: retracted-latest county already done -> no steps; wrong head is refused", async () => {
  let { bytes, c } = county([sdk.STATUS_SUPERSEDED, sdk.STATUS_RETRACTED], [2, 0]);
  assert.deepEqual((await planCounty(sdk, c, bytes, att)).steps, []);
  ({ bytes, c } = county([sdk.STATUS_SUPERSEDED, sdk.STATUS_RETRACTED], [2, 2]));
  await assert.rejects(planCounty(sdk, c, bytes, att), /latest_active_epoch 2/);
});
test("plan: newest epoch SUPERSEDED is refused", async () => {
  const { bytes, c } = county([sdk.STATUS_ACTIVE, sdk.STATUS_SUPERSEDED]);
  await assert.rejects(planCounty(sdk, c, bytes, att), /expected ACTIVE or RETRACTED/);
});

test("piiGuard: optional upper-bound keys", () => {
  const ub = { ...good(), fetched_at_is_upper_bound: true, fetched_at_source: "git abc1234 adds post script [commit time]", fetched_on: "2026-10-01" };
  piiGuard(sdk, ub);
  piiGuard(sdk, { ...good(), fetched_at_is_upper_bound: false, fetched_at_source: "tar mtime", fetched_on: null });
  assert.throws(() => piiGuard(sdk, { ...ub, fetched_at_is_upper_bound: "yes" }), /true or false/);
  assert.throws(() => piiGuard(sdk, { ...ub, fetched_at_source: undefined }), /fetched_at_source/);
  assert.throws(() => piiGuard(sdk, { ...ub, fetched_on: "Oct 1" }), /fetched_on/);
});
test("migrateRootIx: flag byte at offset 121", () => {
  const a = { fips: 48453, epoch: 2, manifestSha: Buffer.alloc(32, 1), sourceSha: Buffer.alloc(32), packetSha: Buffer.alloc(32, 2), dataAsOf: 0, fetchedAt: 1790000000, leafVersion: 2, attestor: sdk.web3 ? undefined : undefined };
  for (const ub of [false, true]) {
    let ix; try { ix = migrateRootIx(sdk, { ...a, fetchedAtIsUpperBound: ub, attestor: new sdk.PublicKey(Buffer.alloc(32, 9)) }); } catch (e) { ix = migrateRootIx(sdk, { ...a, fetchedAtIsUpperBound: ub, attestor: Buffer.alloc(32, 9) }); }
    assert.equal(ix.data.length, 122); assert.equal(ix.data[121], ub ? 1 : 0);
  }
});
test("every real meta bound passes piiGuard", { skip: !fs.existsSync("/workspace/countyroot/meta/meta.json") }, () => {
  const meta = JSON.parse(fs.readFileSync("/workspace/countyroot/meta/meta.json", "utf8"));
  let n = 0;
  for (const m of Object.values(meta.counties ?? meta)) {
    if (m.fetched_at || !m.fetched_no_later_than) continue;
    piiGuard(sdk, { ...good(), fetched_at: m.fetched_no_later_than, fetched_at_is_upper_bound: true, fetched_at_source: m.fetched_no_later_than_source, fetched_on: m.fetched_on ?? null }); n++;
  }
  assert.equal(n, 163);
});
