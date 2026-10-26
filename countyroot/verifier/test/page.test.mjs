// Headless-Chrome test of the verify page, served with the site's real CSP from a local server.
//   node --experimental-websocket --test verifier/test/    (Node 20; Node >= 22 has WebSocket built in)
// Env: COUNTYROOT_SITE_PUBLIC (built site, default /workspace/site/build/public)
//      COUNTYROOT_PROOFS_DIR  (staged v1 proof files incl. the Travis alias build, e.g. /workspace/countyroot/stage/proofs-v2)
//      COUNTYROOT_V2_DIR      (v2 build; Martin.TX from it is listed as v2 so both formats run side by side)
//      CHROME (default google-chrome), COUNTYROOT_LIVE_RPC=0 to skip the case that proxies to the real Devnet RPC.
// The local server serves the site, /packets/* from the proofs dir, and /rpc (a mock, or a proxy to Devnet), and
// rewrites /verify/config.json to point at them, so the page runs under the production CSP with connect-src 'self'.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { startHarness, SCHEMA_V1, SCHEMA_V2 } from "./harness.mjs";

const PUB = process.env.COUNTYROOT_SITE_PUBLIC || "/workspace/site/build/public";
const PROOFS = process.env.COUNTYROOT_PROOFS_DIR || ["/workspace/countyroot/stage/proofs-v2", "/workspace/countyroot/stage/proofs"].find((d) => fs.existsSync(path.join(d, "Travis.TX"))) || "/workspace/countyroot/stage/proofs";
const LIVE = process.env.COUNTYROOT_LIVE_RPC !== "0";
// Mixed formats: if a local v2 build of Martin.TX exists, the test site lists Martin.TX as its v2 epoch (served from
// COUNTYROOT_V2_DIR) while every other county stays v1, so both formats run side by side.
const V2DIR = process.env.COUNTYROOT_V2_DIR || "/workspace/countyroot/stage/v2-all";
const isV2 = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")).leaf_version === 2; } catch { return false; } };
const v2RootFile = fs.existsSync(path.join(V2DIR, "Martin.TX")) ? fs.readdirSync(path.join(V2DIR, "Martin.TX")).find((f) => f.endsWith(".root.json") && isV2(path.join(V2DIR, "Martin.TX", f))) : null;
const HAVE_V2 = !!v2RootFile;
const { state, server, verifyIn, noCsp, reset } = await startHarness({ pub: PUB, proofDirs: HAVE_V2 ? [PROOFS, V2DIR] : [PROOFS], patch: async (counties) => {
  if (!HAVE_V2) return;
  const d = JSON.parse(fs.readFileSync(path.join(V2DIR, "Martin.TX", v2RootFile), "utf8"));
  const i = counties.findIndex((c) => c.label === "Martin.TX");
  const { countyRootPda } = await import(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../sdk/dist/src/index.js"));
  counties[i] = { ...counties[i], epoch: d.epoch, n_parcels: d.n_parcels, merkle_root: d.merkle_root, pda: countyRootPda(d.fips, d.epoch).toBase58(), leaf_version: 2 };
} });

test("Travis.TX: a parcel verifies against the root (mock RPC)", async () => {
  reset(); const r = await verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.equal(r.rows.length, 1); assert.equal(r.rows[0].row, "3"); noCsp(r);
});

test("Travis.TX: live Devnet RPC (proxied same-origin) verifies against the real on-chain root", { skip: !LIVE }, async () => {
  reset(); state.rpc = "live"; const r = await verifyIn("Travis.TX", " 000000park ");
  assert.equal(r.state, "verified", r.text); assert.match(r.anchor, /^onchain(-superseded)?$/); // the v1 site lists epochs that program v2 has since superseded assert.match(r.rows[0].verdict, /Verified on-chain/); noCsp(r);
});

test("MiamiDade.FL: a duplicated parcel ID returns every row, each verified (live RPC when available)", async () => {
  reset(); if (LIVE) state.rpc = "live";
  const r = await verifyIn("MiamiDade.FL", "3069340218780");
  assert.equal(r.state, "verified", r.text); assert.equal(r.rows.length, 87);
  assert.ok(r.rows.every((x) => x.ok === "true")); assert.equal(new Set(r.rows.map((x) => x.row)).size, 87); noCsp(r);
});

test("Osage.OK epoch 2: the redacted replacement ID verifies (live RPC when available)", async () => {
  reset(); if (LIVE) state.rpc = "live";
  const r = await verifyIn("Osage.OK", "UNNUMBERED-41938");
  assert.equal(r.state, "verified", r.text); assert.equal(r.rows[0].row, "41938"); noCsp(r);
});

test("tampered row (acres changed in the shard) fails", async () => {
  reset();
  state.tamper = (p, body) => {
    if (!/\/Travis\.TX\.2\.2026-10\.proofs\/s\/\d+\.json$/.test(p)) return body;
    const j = JSON.parse(body); const row = j.rows.find((x) => x[0] === "0000000ROW"); if (row) row[1] = "9.334422";
    return Buffer.from(JSON.stringify(j));
  };
  const r = await verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "failed", r.text); assert.equal(r.rows[0].ok, "false"); assert.match(r.rows[0].verdict, /Not verified/); noCsp(r);
});

test("tampered sibling leaf in the chunk file fails", async () => {
  reset();
  state.tamper = (p, body) => { if (/\/Travis\.TX\.2\.2026-10\.proofs\/c\/0\.bin$/.test(p)) { body = Buffer.from(body); body[0] ^= 0xff; } return body; };
  const r = await verifyIn("Travis.TX", "0000000ROW"); // leaf index 1; its sibling is leaf 0
  assert.equal(r.state, "failed", r.text);
});

test("retracted on-chain root fails even though the proof matches", async () => {
  reset(); state.rpc = "retracted"; const r = await verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "failed", r.text); assert.match(r.text, /RETRACTED/);
});

test("RPC unreachable: falls back to the published fingerprint, clearly labelled", async () => {
  reset(); state.rpc = "down"; const r = await verifyIn("Osage.OK", "UNNUMBERED-41938");
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "published"); assert.match(r.rows[0].verdict, /published fingerprint/); noCsp(r);
});

test("unknown parcel ID: not found", async () => {
  reset(); const r = await verifyIn("Osage.OK", "NO-SUCH-PARCEL-123");
  assert.equal(r.state, "notfound", r.text);
});

test("county without published proofs: says so", async () => {
  reset(); const r = await verifyIn("Adams.CO", "anything");
  assert.equal(r.state, "unpublished", r.text);
});

test("harness really enforces the CSP: a proof host outside connect-src is blocked", async () => {
  reset(); state.packets = `http://localhost:${server.address().port}/packets`; // other origin, not in connect-src
  const r = await verifyIn("Osage.OK", "UNNUMBERED-41938");
  assert.equal(r.state, "error", r.text); assert.ok(r.logs.some((l) => /Content Security Policy|Refused to connect/i.test(l)), r.logs.join(" | "));
});

test("Travis 0240050817 (leading zero) resolves to 240050817 and verifies", async () => {
  reset(); if (LIVE) state.rpc = "live";
  const r = await verifyIn("Travis.TX", "0240050817");
  assert.equal(r.state, "verified", r.text); assert.equal(r.resolved, "normalized"); assert.equal(r.matched, "240050817");
  assert.match(r.text, /You typed 0240050817; matched 240050817/); assert.equal(r.rows.length, 1); noCsp(r);
});

test("Travis Property ID 244256 resolves via the TCAD alias to 240050817 and verifies, with the not-in-fingerprint note", async () => {
  reset(); if (LIVE) state.rpc = "live";
  const r = await verifyIn("Travis.TX", "244256");
  assert.equal(r.state, "verified", r.text); assert.equal(r.resolved, "alias"); assert.equal(r.matched, "240050817");
  assert.match(r.text, /TCAD Property ID 244256 → parcel ID 240050817/); assert.match(r.text, /NOT part of the on-chain fingerprint/);
  assert.match(r.hint, /TCAD Property ID/); noCsp(r);
});

test("Travis 12601-01-01 (dashes) verifies 126010101", async () => {
  reset(); const r = await verifyIn("Travis.TX", "12601-01-01");
  assert.equal(r.state, "verified", r.text); assert.equal(r.matched, "126010101"); noCsp(r);
});

test("Travis '12601' is not found but suggests IDs including 126010101, and a suggestion link verifies", async () => {
  reset(); const r = await verifyIn("Travis.TX", "12601");
  assert.equal(r.state, "notfound", r.text); assert.ok(r.suggestions.length > 0 && r.suggestions.length <= 10);
  const s = r.suggestions.find((x) => x.id === "126010101"); assert.ok(s, JSON.stringify(r.suggestions));
  const q = new URLSearchParams(s.href.slice(1)); const r2 = await verifyIn(q.get("c"), q.get("p"));
  assert.equal(r2.state, "verified", r2.text); assert.equal(r2.resolved, null); noCsp(r);
});

test("tampered row still fails when found through an alias", async () => {
  reset();
  state.tamper = (p, body) => {
    if (!/\/Travis\.TX\.2\.2026-10\.proofs\/s\/\d+\.json$/.test(p)) return body;
    const j = JSON.parse(body); const row = j.rows.find((x) => x[0] === "240050817"); if (row) row[1] = "1.000000";
    return Buffer.from(JSON.stringify(j));
  };
  const r = await verifyIn("Travis.TX", "244256");
  assert.equal(r.state, "failed", r.text); assert.equal(r.resolved, "alias");
});

// ---------- leaf format v2 alongside v1 (local v2 build of Martin.TX; all other counties v1) ----------
const v2skip = !HAVE_V2 && "no local v2 build (node scripts/build_v2.mjs --csv Martin.TX.1.2026-10.csv --out stage/v2-all)";
const v2rows = HAVE_V2 ? (() => { const d = path.join(V2DIR, "Martin.TX", fs.readdirSync(path.join(V2DIR, "Martin.TX")).find((f) => f.endsWith(".proofs"))); return { dir: d, rows: JSON.parse(fs.readFileSync(path.join(d, "r/3.json"))).rows }; })() : null;
test("v2: a Martin.TX parcel verifies against a v2 root (schema v2), next to v1 counties", { skip: v2skip }, async () => {
  reset(); const id = v2rows.rows[17][0];
  const r = await verifyIn("Martin.TX", id);
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.equal(r.rows.length, 1);
  assert.match(r.text, /fingerprint format v2/); noCsp(r);
  const r1 = await verifyIn("Travis.TX", "0000000ROW"); assert.equal(r1.state, "verified", r1.text); // v1 still fine
});
test("v2: leading zeros / dashes resolve through the sorted key", { skip: v2skip }, async () => {
  reset(); const id = v2rows.rows[5][0];
  const r = await verifyIn("Martin.TX", `00${id}`);
  assert.equal(r.state, "verified", r.text); assert.equal(r.resolved, "normalized"); assert.equal(r.matched, id); noCsp(r);
});
test("v2: an unknown ID is not found AND proven absent (adjacent leaves)", { skip: v2skip }, async () => {
  reset(); const r = await verifyIn("Martin.TX", `${v2rows.rows[5][0]}ZZ`);
  assert.equal(r.state, "notfound", r.text); assert.equal(r.absence, "proven"); assert.match(r.text, /Absence proven on-chain/); noCsp(r);
});
test("v2: tampered row (acres) fails; a v1-schema root for v2 files fails", { skip: v2skip }, async () => {
  reset(); const id = v2rows.rows[17][0];
  state.tamper = (p, body) => { if (!/Martin\.TX\.\d+\.2026-10\.proofs\/r\/3\.json$/.test(p)) return body; const j = JSON.parse(body); j.rows[17][2] += 1; return Buffer.from(JSON.stringify(j)); };
  let r = await verifyIn("Martin.TX", id); assert.equal(r.state, "failed", r.text);
  reset(); state.v2schema = SCHEMA_V1;
  r = await verifyIn("Martin.TX", id); assert.equal(r.state, "failed", r.text); assert.match(r.text, /fingerprint format/);
});

test("page fetched only same-origin URLs (CSP connect-src 'self' held)", () => {
  assert.ok(state.requests.some((u) => u.startsWith("/packets/")) && state.requests.includes("/rpc"));
});
