// node --test scripts/build_proofs.test.mjs   (needs the SDK built: cd sdk && npm ci && npm run build)
// Optional real packets: COUNTYROOT_PROOF_PACKETS="/path/A.csv:/path/B.csv" (each with its root.json beside it, or
// set COUNTYROOT_PROOF_ROOTS to a matching ':' list). Each is built offline and every row's proof is compared with the SDK.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { buildSidecar, selfCheck, buildProofs } from "./build_proofs.mjs";
import { loadSdk, VerifyError } from "./verify.mjs";
import * as V from "../verifier/cr-verify.js";

const sdk = await loadSdk();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proofs-"));
const mkRows = (n, f = (i) => `P-${i}`) => Array.from({ length: n }, (_, i) => ({ parcel_id: f(i), acres: (i * 0.25).toFixed(6), lot_sqft: (i * 10890).toFixed(2) }));
const levelsOf = (rows) => sdk.buildLevels(rows.map((r) => sdk.leafHash(r.parcel_id, r.acres, r.lot_sqft)));
const loader = (files) => async (name) => {
  const b = files.get(name); if (!b) throw Object.assign(new Error(`404 ${name}`), { notFound: true });
  return name.endsWith(".json") ? { json: JSON.parse(b) } : { bytes: new Uint8Array(b) };
};
async function sidecar(rows, opts = {}) {
  const levels = levelsOf(rows);
  const root = levels[levels.length - 1][0].toString("hex");
  const meta = { label: "Test.ZZ", fips: 99001, epoch: 1, month: "2026-10", merkle_root: root };
  const sc = await buildSidecar({ rows, levels, meta, ...opts });
  return { ...sc, levels, root, county: { label: "Test.ZZ", fips: 99001, epoch: 1, n_parcels: rows.length, merkle_root: root, pda: "x" } };
}
const active = (c, over = {}) => async () => ({ fips: c.fips, epoch: c.epoch, nParcels: BigInt(c.n_parcels), merkleRoot: c.merkle_root, status: 1, postedAt: 0, version: 1, ...over });

test("assembled proofs equal the SDK's for every leaf, across chunk boundaries and odd sizes", async () => {
  for (const chunk of [2, 4, 8]) for (let n = 1; n <= 70; n++) {
    const rows = mkRows(n), s = await sidecar(rows, { chunk, rowsPerShard: 7 });
    assert.equal(await selfCheck({ files: s.files, index: s.index, levels: s.levels, sdk }), n, `chunk ${chunk} n ${n}`);
  }
});

test("browser-side merkle code matches the SDK (leaf, formatFixed, root)", async () => {
  const cases = [["A-1", "1.2345675", "100.005"], ["0", "0", "0"], ["X", "1e-7", "12345678.995"], ["LOT \"A\"", "-0.0000004", "-1.005"]];
  for (const [p, a, s] of cases) {
    assert.equal(V.formatFixed(a, 6), sdk.formatFixed(a, 6)); assert.equal(V.formatFixed(s, 2), sdk.formatFixed(s, 2));
    assert.equal(V.toHex(await V.leafHash(p, a, s)), sdk.leafHash(p, a, s).toString("hex"));
  }
  const rows = mkRows(1000), lv = levelsOf(rows);
  const mine = await V.buildLevels(rows.map((r) => new Uint8Array(sdk.leafHash(r.parcel_id, r.acres, r.lot_sqft))));
  assert.equal(V.toHex(mine[mine.length - 1][0]), lv[lv.length - 1][0].toString("hex"));
});

test("verifyParcel finds and verifies a parcel (case-insensitive lookup)", async () => {
  const s = await sidecar(mkRows(300), { chunk: 16, rowsPerShard: 20 });
  const r = await V.verifyParcel({ county: s.county, parcelId: " p-123 ", load: loader(s.files), onchain: active(s.county) });
  assert.equal(r.found, true); assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].ok, true); assert.equal(r.rows[0].row, 125); assert.equal(r.anchor.kind, "onchain");
  const miss = await V.verifyParcel({ county: s.county, parcelId: "NOPE", load: loader(s.files), onchain: active(s.county) });
  assert.equal(miss.found, false);
});

test("duplicate parcel IDs: every matching row is returned with its own index, and each verifies", async () => {
  const rows = mkRows(200, (i) => (i % 50 === 7 ? "DUP-1" : `P-${i}`));
  rows[57].acres = "9.000000"; // duplicates can carry different values; each row has its own leaf
  const s = await sidecar(rows, { chunk: 8, rowsPerShard: 30 });
  const r = await V.verifyParcel({ county: s.county, parcelId: "DUP-1", load: loader(s.files), onchain: active(s.county) });
  assert.deepEqual(r.rows.map((x) => x.index), [7, 57, 107, 157]);
  assert.ok(r.rows.every((x) => x.ok));
});

test("tampering fails: row values, chunk leaves, top nodes, row index, parcel count", async () => {
  const base = await sidecar(mkRows(300), { chunk: 16, rowsPerShard: 40 });
  const id = "P-200", k = await V.shardOf(id, base.index.n_shards);
  const edit = (fn) => { const f = new Map(base.files); fn(f); return f; };
  const shardEdit = (fn) => edit((f) => { const j = JSON.parse(f.get(`s/${k}.json`)); fn(j.rows.find((r) => r[0] === id)); f.set(`s/${k}.json`, Buffer.from(JSON.stringify(j))); });
  const run = (files, county = base.county, onchain = active(base.county)) => V.verifyParcel({ county, parcelId: id, load: loader(files), onchain });
  assert.equal((await run(base.files)).rows[0].ok, true);
  assert.equal((await run(shardEdit((r) => { r[1] = "999.000000"; }))).rows[0].ok, false, "acres");
  assert.equal((await run(shardEdit((r) => { r[3] = 201; }))).rows[0].ok, false, "index");
  const c = Math.floor(200 / 16);
  assert.equal((await run(edit((f) => { const b = Buffer.from(f.get(`c/${c}.bin`)); b[(201 % 16) * 32] ^= 1; f.set(`c/${c}.bin`, b); }))).rows[0].ok, false, "sibling leaf");
  assert.equal((await run(edit((f) => { const b = Buffer.from(f.get("top.bin")); b[(c ^ 1) * 32] ^= 1; /* the on-path sibling chunk root */ f.set("top.bin", b); }))).rows[0].ok, false, "top node");
  // an off-path node is not used by this proof, so changing it must not matter
  assert.equal((await run(edit((f) => { const b = Buffer.from(f.get("top.bin")); b[0] ^= 1; f.set("top.bin", b); }))).rows[0].ok, true, "off-path node");
  // a wrong on-chain root, a retracted root, or a different parcel count all fail
  assert.equal((await run(base.files, base.county, active(base.county, { merkleRoot: "00".repeat(32) }))).rows[0].ok, false);
  assert.equal((await run(base.files, base.county, active(base.county, { status: 2 }))).rows[0].ok, false);
  await assert.rejects(run(base.files, base.county, active(base.county, { nParcels: 301n })), /cover 300 parcels/);
});

test("RPC unreachable: falls back to the published fingerprint and says so", async () => {
  const s = await sidecar(mkRows(50), { chunk: 8 });
  const r = await V.verifyParcel({ county: s.county, parcelId: "P-3", load: loader(s.files), onchain: async () => { throw new Error("network down"); } });
  assert.equal(r.anchor.kind, "published"); assert.equal(r.rows[0].ok, true);
  const bad = await V.verifyParcel({ county: { ...s.county, merkle_root: "11".repeat(32) }, parcelId: "P-3", load: loader(s.files), onchain: async () => { throw new Error("x"); } });
  assert.equal(bad.rows[0].ok, false);
});

test("account decoder matches the SDK layout", async () => {
  const d = Buffer.alloc(99); sdk.ACCOUNT_DISCRIMINATORS.CountyRoot.copy(d, 0);
  d.writeUInt32LE(48453, 8); d.writeUInt32LE(2, 12); d.writeBigUInt64LE(386068n, 16); Buffer.alloc(32, 7).copy(d, 24); d[88] = 1; d.writeBigInt64LE(1791866144n, 89); d[97] = 254; d[98] = 1;
  const a = await V.decodeCountyRoot(new Uint8Array(d)), b = sdk.decodeCountyRoot(d);
  assert.equal(a.fips, b.fips); assert.equal(a.epoch, b.epoch); assert.equal(a.nParcels, b.nParcels); assert.equal(a.merkleRoot, b.merkleRoot.toString("hex"));
  assert.equal(a.status, b.status); assert.equal(BigInt(a.postedAt), b.postedAt); assert.equal(a.version, b.version);
  d[0] ^= 1; await assert.rejects(V.decodeCountyRoot(new Uint8Array(d)), /not a CountyRoot/);
  assert.equal(V.base58(new Uint8Array(sdk.PROGRAM_ID.toBytes())), sdk.PROGRAM_ID.toBase58());
});

test("shards respect the size cap", async () => {
  const s = await sidecar(mkRows(5000), { chunk: 64, rowsPerShard: 5000, maxBytes: 20 * 1024 });
  for (const [name, b] of s.files) if (name.startsWith("s/")) assert.ok(b.length <= 20 * 1024, `${name} ${b.length}`);
});

test("buildProofs refuses a packet whose CSV does not rebuild its root.json", async () => {
  const dir = path.join(tmp, "bad"); fs.mkdirSync(dir);
  const rows = mkRows(5), lv = levelsOf(rows);
  fs.writeFileSync(path.join(dir, "Bad.ZZ.1.2026-10.csv"), ["parcel_id,acres,lot_sqft", ...rows.map((r) => `${r.parcel_id},${r.acres},${r.lot_sqft}`)].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "Bad.ZZ.1.2026-10.root.json"), JSON.stringify({ fips: 99002, epoch: 1, n_parcels: 5, merkle_root: "ab".repeat(32) }));
  await assert.rejects(buildProofs({ csvPath: path.join(dir, "Bad.ZZ.1.2026-10.csv"), outDir: path.join(tmp, "out"), offline: true }), (e) => e instanceof VerifyError);
  fs.writeFileSync(path.join(dir, "Bad.ZZ.1.2026-10.root.json"), JSON.stringify({ fips: 99002, epoch: 1, n_parcels: 5, merkle_root: lv[lv.length - 1][0].toString("hex") }));
  const s = await buildProofs({ csvPath: path.join(dir, "Bad.ZZ.1.2026-10.csv"), outDir: path.join(tmp, "out"), offline: true });
  assert.equal(s.n_parcels, 5); assert.ok(fs.existsSync(path.join(tmp, "out/Bad.ZZ/Bad.ZZ.1.2026-10.proofs/index.json")));
});

const real = (process.env.COUNTYROOT_PROOF_PACKETS || "").split(":").filter(Boolean);
const realRoots = (process.env.COUNTYROOT_PROOF_ROOTS || "").split(":");
real.forEach((csv, i) => test(`real packet ${path.basename(csv)}: every row's proof matches the SDK and the root`, { timeout: 1800000 }, async () => {
  const s = await buildProofs({ csvPath: csv, rootPath: realRoots[i] || undefined, outDir: path.join(tmp, "real"), offline: true, sample: 0 });
  assert.equal(s.proofs_checked, s.n_parcels);
  const doc = JSON.parse(fs.readFileSync(realRoots[i] || csv.replace(/\.csv$/, ".root.json"), "utf8"));
  const idx = JSON.parse(fs.readFileSync(path.join(s.dir, "index.json"), "utf8"));
  assert.equal(idx.merkle_root, doc.merkle_root);
  for (const [name] of [["index.json"]]) assert.ok(fs.statSync(path.join(s.dir, name)).size < 4096);
  for (const sub of ["s", "c"]) for (const f of fs.readdirSync(path.join(s.dir, sub))) assert.ok(fs.statSync(path.join(s.dir, sub, f)).size <= 100 * 1024, `${sub}/${f}`);
}));

test("scan_proofs flags personal-info-shaped and forbidden IDs, and passes clean shards", async () => {
  const { scanProofs } = await import("./scan_proofs.mjs");
  const dir = path.join(tmp, "scan/Test.ZZ/Test.ZZ.1.2026-10.proofs/s"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "0.json"), JSON.stringify({ format: 1, shard: 0, rows: [["P-1", "1.000000", "1.00", 0], ["0000000ROW", "1.000000", "1.00", 1]] }));
  let r = await scanProofs({ dir: path.join(tmp, "scan") });
  assert.equal(r.rows, 2); assert.equal(r.pii.length, 0);
  fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ format: 1, shard: 1, rows: [["DOE; JANE", "1.000000", "1.00", 2]] }));
  r = await scanProofs({ dir: path.join(tmp, "scan") });
  assert.equal(r.pii.length, 1); assert.equal(r.pii[0].reason, "last_first"); assert.ok(!JSON.stringify(r).includes("JANE"));
  const forbid = path.join(tmp, "forbid.csv"); fs.writeFileSync(forbid, "parcel_id,acres,lot_sqft\nP-1,1,1\nKEEP,1,1\n");
  const except = path.join(tmp, "except.csv"); fs.writeFileSync(except, "parcel_id,acres,lot_sqft\nKEEP,1,1\n");
  r = await scanProofs({ dir: path.join(tmp, "scan"), forbid: [forbid], except: [except] });
  assert.equal(r.forbidden_ids, 1); assert.equal(r.denied.length, 1);
});
