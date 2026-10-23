// Offline tests for @countyroot/sdk/web: a tiny v2 tree served from memory through the real verifier code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyParcel, readCountyRoot, core, type County } from "../src/web.js";
import { buildTreeV2, canonicalRowsV2, SCHEMA_V2 } from "../src/leafv2.js";
import { ACCOUNT_DISCRIMINATORS } from "../src/accounts.js";

const FIPS = 99001, EPOCH = 2, PDA = "11111111111111111111111111111112";
const rows = canonicalRowsV2([{ parcel_id: "A-100", acres: "1.5", lot_sqft: "65340" }, { parcel_id: "B-200", acres: "0.25", lot_sqft: "10890" }, { parcel_id: "C-300", acres: "2", lot_sqft: "87120" }]);
const t = buildTreeV2(FIPS, EPOCH, rows);
const C = 2, nChunks = Math.ceil(rows.length / C);
const leaves = t.levels[0];
const files: Record<string, unknown> = {
  "index.json": { format: 2, leaf_version: 2, fips: FIPS, epoch: EPOCH, schema: SCHEMA_V2.toString("hex"), n_leaves: rows.length, n_parcels: rows.length, chunk_size: C, n_chunks: nChunks },
  "f.json": { fences: Array.from({ length: nChunks }, (_, k) => rows[k * C].id.toUpperCase()) },
  "top.bin": new Uint8Array(Buffer.concat(t.levels.slice(1).flat())),
};
for (let k = 0; k < nChunks; k++) {
  files[`r/${k}.json`] = { rows: rows.slice(k * C, (k + 1) * C).map((r) => [r.id, r.occ, Number(r.acresMicro), Number(r.sqftCenti)]) };
  files[`c/${k}.bin`] = new Uint8Array(Buffer.concat(leaves.slice(k * C, (k + 1) * C)));
}
function account(status: number, root = t.root) {
  const b = Buffer.alloc(99); ACCOUNT_DISCRIMINATORS.CountyRoot.copy(b, 0);
  b.writeUInt32LE(FIPS, 8); b.writeUInt32LE(EPOCH, 12); b.writeBigUInt64LE(BigInt(rows.length), 16);
  root.copy(b, 24); SCHEMA_V2.copy(b, 56); b[88] = status; b[98] = 1; return b;
}
const county: County = { label: "Test.XX", fips: FIPS, epoch: EPOCH, month: "2026-10", n_parcels: rows.length, merkle_root: t.root.toString("hex"), pda: PDA, leaf_version: 2 };
function fakeFetch(status = 1, owner: string = (core as any).PROGRAM_ID): typeof fetch {
  return (async (url: string, init?: any) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ result: { context: { slot: 7 }, value: { owner, data: [account(status).toString("base64"), "base64"] } } }));
    const name = String(url).split(".proofs/")[1], v = files[name];
    if (v === undefined) return new Response("", { status: 404 });
    return new Response(v instanceof Uint8Array ? (v as any) : JSON.stringify(v));
  }) as any;
}

test("verifyParcel: found parcel verifies against an active on-chain root", async () => {
  const r = await verifyParcel(county, "b-200", { fetch: fakeFetch() });
  assert.equal(r.verified, true); assert.equal(r.anchor.kind, "onchain"); assert.equal(r.rows[0].parcel_id, "B-200");
});
test("verifyParcel: retracted root is not verified", async () => {
  const r = await verifyParcel(county, "A-100", { fetch: fakeFetch(2) });
  assert.equal(r.found, true); assert.equal(r.verified, false);
});
test("verifyParcel: missing parcel is not verified", async () => {
  const r = await verifyParcel(county, "Z-999", { fetch: fakeFetch() });
  assert.equal(r.found, false); assert.equal(r.verified, false);
});
test("readCountyRoot: rejects accounts not owned by CountyRoot", async () => {
  await assert.rejects(readCountyRoot(PDA, { fetch: fakeFetch(1, "11111111111111111111111111111111") }), /not owned/);
  const a = await readCountyRoot(PDA, { fetch: fakeFetch() });
  assert.equal(a!.fips, FIPS); assert.equal(a!.merkleRoot, t.root.toString("hex"));
});
test("verifyParcel: superseded root still verifies as historical, with a warning", async () => {
  const r = await verifyParcel(county, "A-100", { fetch: fakeFetch(3) });
  assert.equal(r.verified, true); assert.equal(r.anchor.current, false);
  assert.match(r.anchor.warnings![0], /not the latest epoch: superseded by epoch/);
});
test("web core decodes the v2 tail of a real 256-byte account", async () => {
  const fs = await import("node:fs"); const path = await import("node:path"); const { fileURLToPath } = await import("node:url");
  const fx = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/v2.json"), "utf8"));
  const s = await core.decodeCountyRoot(new Uint8Array(Buffer.from(fx.superseded, "base64")));
  assert.equal(s.status, 3); assert.equal(s.supersededBy, 2); assert.equal(s.version, 2); assert.equal(s.migrated, false);
  const m = await core.decodeCountyRoot(new Uint8Array(Buffer.from(fx.migrated, "base64")));
  assert.equal(m.migrated, true); assert.equal(m.sourceSha256, "00".repeat(32));
  const l = await core.decodeCountyRoot(new Uint8Array(Buffer.from(fx.legacy99, "base64")));
  assert.equal(l.manifestSha256, undefined); assert.equal(l.version, 1);
});
