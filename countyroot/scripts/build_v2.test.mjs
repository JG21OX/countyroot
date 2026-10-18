// v2 prototype: the browser verifier (verifier/cr-verify.js) must agree with the SDK byte for byte, on proof files
// written by build_v2.mjs. Needs the SDK built (cd sdk && npm run build).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadSdk } from "./verify.mjs";
import { sidecarV2, diffV2, main } from "./build_v2.mjs";
import * as V from "../verifier/cr-verify.js";

const sdk = await loadSdk();
const mkRows = (n, f = (i) => [`P-${String(i * 7).padStart(6, "0")}`, `${(i % 97) / 7}`, `${i * 3}.5`]) =>
  Array.from({ length: n }, (_, i) => { const [parcel_id, acres, lot_sqft] = f(i); return { parcel_id, acres, lot_sqft }; });
function setup({ rows, fips = 48317, epoch = 2, chunk = 4, schema = V.SCHEMA_V2_HEX, status = 1, tamper } = {}) {
  const tree = sdk.buildTreeV2(fips, epoch, sdk.canonicalRowsV2(rows));
  const { files, index } = sidecarV2(sdk, tree, { label: "T.XX", fips, epoch, month: "2026-10" }, chunk);
  const county = { label: "T.XX", fips, epoch, n_parcels: tree.rows.length, merkle_root: tree.root.toString("hex"), pda: "x" };
  const load = async (name) => {
    let b = files.get(name); if (!b) throw Object.assign(new Error("404 " + name), { notFound: true });
    if (tamper) b = tamper(name, Buffer.from(b));
    return name.endsWith(".json") ? { json: JSON.parse(b) } : { bytes: new Uint8Array(b) };
  };
  const onchain = async () => ({ fips, epoch, nParcels: BigInt(tree.rows.length), merkleRoot: tree.root.toString("hex"), schema, status, postedAt: 0, version: 1 });
  return { tree, files, index, county, load, onchain };
}

test("browser and SDK agree: leaf, node, root and the v2 schema hash", async () => {
  assert.equal(V.SCHEMA_V2_HEX, sdk.SCHEMA_V2.toString("hex"));
  assert.equal(V.SCHEMA_V1_HEX, sdk.SCHEMA_V1.toString("hex"));
  for (const [id, occ, a, s] of [["0", 0, 415276n, 1808900n], ["UNNUMBERED-41938", 3, 0n, 0n], ["14 30 01 01117 000 0001", 0, 30989959000000n, 134992261404000n]]) {
    const x = sdk.leafHashV2(40113, { id, occ, acresMicro: a, sqftCenti: s }).toString("hex");
    assert.equal(V.toHex(await V.leafHashV2(40113, id, occ, a, s)), x);
    assert.equal(V.keyV2(id), sdk.keyV2(id));
  }
  const l = Buffer.alloc(32, 1), r = Buffer.alloc(32, 2);
  assert.equal(V.toHex(await V.nodeHashV2(l, r)), sdk.nodeHashV2(l, r).toString("hex"));
  assert.equal(V.toHex(await V.rootHashV2(1, 2, 3, l)), sdk.rootHashV2(1, 2, 3, l).toString("hex"));
});

test("every leaf verifies through the proof files for awkward sizes (1, 2, 3, 5, 17, 33 leaves; chunk 4)", async () => {
  for (const n of [1, 2, 3, 5, 17, 33]) {
    const s = setup({ rows: mkRows(n) });
    for (const row of s.tree.rows) {
      const res = await V.verifyParcel({ county: s.county, parcelId: row.id, load: s.load, onchain: s.onchain });
      assert.ok(res.found && res.rows.length === 1 && res.rows[0].ok, `n=${n} ${row.id}: ${JSON.stringify(res.rows[0]?.reason)}`);
      // the page's downloadable proof is an SDK v2 proof
      assert.ok(sdk.verifyProofV2(res.rows[0].proof, s.tree.root));
    }
  }
});

test("normalized lookup, repeated IDs and absence proofs in the browser verifier", async () => {
  const rows = [...mkRows(20), { parcel_id: "P-000014", acres: "1", lot_sqft: "2" }, { parcel_id: "P-000014", acres: "0.5", lot_sqft: "2" }];
  const s = setup({ rows });
  let res = await V.verifyParcel({ county: s.county, parcelId: "p 000014", load: s.load, onchain: s.onchain });
  assert.equal(res.found, true); assert.equal(res.resolution.mode, "normalized"); assert.equal(res.rows.length, 3);
  assert.deepEqual(res.rows.map((r) => r.occ), [0, 1, 2]); assert.ok(res.rows.every((r) => r.ok));
  for (const q of ["P-000015", "A", "ZZZ", "P-0000140"]) {
    res = await V.verifyParcel({ county: s.county, parcelId: q, load: s.load, onchain: s.onchain });
    assert.equal(res.found, false, q); assert.ok(res.absence.ok, `${q}: ${res.absence.reason}`);
    const want = sdk.makeAbsenceProofV2(s.tree, q);
    assert.equal(res.absence.left?.index ?? null, want.left?.index ?? null); assert.equal(res.absence.right?.index ?? null, want.right?.index ?? null);
  }
  res = await V.verifyParcel({ county: s.county, parcelId: "P-00001", load: s.load, onchain: s.onchain });
  assert.ok(res.suggestions.includes("P-000014"), JSON.stringify(res.suggestions));
});

test("tampered rows, chunks, fences, or the wrong on-chain format all fail", async () => {
  const rows = mkRows(40);
  const target = sdk.canonicalRowsV2(rows)[13].id;
  const cases = {
    row: (n, b) => { if (!n.startsWith("r/")) return b; const j = JSON.parse(b); for (const r of j.rows) if (r[0] === target) r[2] += 1; return Buffer.from(JSON.stringify(j)); },
    chunk: (n, b) => { if (n === "c/3.bin") b[0] ^= 1; return b; },
    top: (n, b) => { if (n === "top.bin") b[2 * 32] ^= 1; return b; }, // chunk 2 root = the sibling of chunk 3
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const s = setup({ rows, tamper });
    const res = await V.verifyParcel({ county: s.county, parcelId: target, load: s.load, onchain: s.onchain });
    assert.ok(!res.found || !res.rows[0].ok, name);
  }
  // fences moved: the search may land elsewhere, but it can never "prove" absence of a present key
  const s2 = setup({ rows, tamper: (n, b) => { if (n !== "f.json") return b; const j = JSON.parse(b); j.fences = j.fences.map(() => "ZZZZ"); return Buffer.from(JSON.stringify(j)); } });
  const r2 = await V.verifyParcel({ county: s2.county, parcelId: target, load: s2.load, onchain: s2.onchain });
  assert.ok(r2.found ? r2.rows.every((r) => r.ok) : !r2.absence.ok);
  // the on-chain account must say v2: a v1-schema root fails even when the root bytes match
  const s3 = setup({ rows, schema: V.SCHEMA_V1_HEX });
  const r3 = await V.verifyParcel({ county: s3.county, parcelId: target, load: s3.load, onchain: s3.onchain });
  assert.equal(r3.rows[0].proofOk, true); assert.equal(r3.rows[0].ok, false); assert.match(r3.rows[0].reason, /format/);
  // cross-county: proof files for another FIPS against this county's root fail
  const s4 = setup({ rows, fips: 12086 });
  const r4 = await V.verifyParcel({ county: { ...s4.county, fips: 48317 }, parcelId: target, load: s4.load, onchain: s4.onchain }).catch((e) => e);
  assert.ok(r4 instanceof Error && /different county/.test(r4.message));
});

test("diffV2 and the CLI: same data -> no changes; a changed value is one changed leaf", async () => {
  const a = sdk.buildTreeV2(1, 5, sdk.canonicalRowsV2(mkRows(50)));
  const rows = mkRows(50); rows[7].acres = "123.5"; rows.push({ parcel_id: "NEW-1", acres: "1", lot_sqft: "1" });
  const b = sdk.buildTreeV2(1, 5, sdk.canonicalRowsV2(rows));
  assert.deepEqual(diffV2(a, b), { unchanged: 49, changed: 1, added: 1, removed: 0 });
  // v2 proof through the SDK CLI (offline, against a v2 root.json)
  const { main: cli } = await import(path.join(path.dirname(new URL(import.meta.url).pathname), "../sdk/dist/src/cli.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2cli-"));
  fs.writeFileSync(path.join(dir, "r.json"), JSON.stringify({ fips: 1, epoch: 5, n_parcels: b.rows.length, merkle_root: b.root.toString("hex") }));
  fs.writeFileSync(path.join(dir, "p.json"), JSON.stringify(sdk.makeProofV2(b, 3)));
  const out = []; assert.equal(await cli(["verify", "--root", path.join(dir, "r.json"), "--proof", path.join(dir, "p.json")], (s) => out.push(s)), 0, out.join("\n"));
  fs.writeFileSync(path.join(dir, "p.json"), JSON.stringify({ ...sdk.makeProofV2(b, 3), epoch: 4 }));
  assert.equal(await cli(["verify", "--root", path.join(dir, "r.json"), "--proof", path.join(dir, "p.json")], () => {}), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
