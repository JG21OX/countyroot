// Headless Chrome, real CSP: the verify page on a site where every county is on its leaf-format-v2 epoch.
//   COUNTYROOT_SITE_V2_PUBLIC=<site built with v2 epochs> COUNTYROOT_V2_DIR=<v2 build> node --experimental-websocket --test verifier/test/page_v2.test.mjs
// Skips unless both exist. The RPC is a mock built from counties.json (v2 roots are not on Devnet until posted).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { startHarness, SCHEMA_V1 } from "./harness.mjs";

const PUB = process.env.COUNTYROOT_SITE_V2_PUBLIC || "/workspace/site/build-v2/public";
const V2DIR = process.env.COUNTYROOT_V2_DIR || "/workspace/countyroot/stage/v2-all";
const ready = fs.existsSync(path.join(PUB, "verify/counties.json")) && fs.existsSync(V2DIR)
  && JSON.parse(fs.readFileSync(path.join(PUB, "verify/counties.json"), "utf8")).counties.some((c) => c.leaf_version === 2);
const skip = !ready && "no v2 site build / v2 packets (build_site.py with CR_V2_DIR, then set COUNTYROOT_SITE_V2_PUBLIC)";
const H = ready ? await startHarness({ pub: PUB, proofDirs: [V2DIR] }) : null;
const C = (label) => H.counties.find((c) => c.label === label);
const proofsDir = (c) => path.join(V2DIR, c.label, `${c.label}.${c.epoch}.${c.month}.proofs`);

test("every county on the v2 site is a v2 epoch with v2 proof files", { skip }, () => {
  assert.equal(H.counties.length, 212);
  for (const c of H.counties) {
    assert.equal(c.leaf_version, 2, c.label);
    const ix = JSON.parse(fs.readFileSync(path.join(proofsDir(c), "index.json"), "utf8"));
    assert.equal(ix.format, 2); assert.equal(ix.epoch, c.epoch); assert.equal(ix.merkle_root, c.merkle_root); assert.equal(ix.n_leaves, c.n_parcels);
  }
});

test("Travis v2: exact, normalized, TCAD alias, and not-found with suggestions + absence proof", { skip }, async () => {
  H.reset();
  let r = await H.verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.match(r.text, /fingerprint format v2/); H.noCsp(r);
  r = await H.verifyIn("Travis.TX", "0240050817");
  assert.equal(r.state, "verified", r.text); assert.equal(r.resolved, "normalized"); assert.equal(r.matched, "240050817");
  r = await H.verifyIn("Travis.TX", "244256");
  assert.equal(r.state, "verified", r.text); assert.equal(r.resolved, "alias"); assert.equal(r.matched, "240050817");
  assert.match(r.text, /NOT part of the on-chain fingerprint/); assert.match(r.hint, /TCAD Property ID/); H.noCsp(r);
  r = await H.verifyIn("Travis.TX", "12601");
  assert.equal(r.state, "notfound", r.text); assert.equal(r.absence, "proven");
  assert.ok(r.suggestions.some((s) => s.id === "126010101"), JSON.stringify(r.suggestions));
});

test("MiamiDade v2: a repeated parcel ID returns every row (occ 0..86), each verified", { skip }, async () => {
  H.reset(); const r = await H.verifyIn("MiamiDade.FL", "3069340218780");
  assert.equal(r.state, "verified", r.text); assert.equal(r.rows.length, 87); assert.ok(r.rows.every((x) => x.ok === "true"));
  assert.equal(new Set(r.rows.map((x) => x.row)).size, 87); H.noCsp(r);
});

test("NOIDs: Osage and East Baton Rouge replacements verify; the old UNNUMBERED IDs are proven absent", { skip }, async () => {
  H.reset();
  for (const [label, id] of [["Osage.OK", "NOID-FF56C03DE20FF661"], ["EastBatonRouge.LA", "NOID-606909389DF132DB"], ["EastBatonRouge.LA", "NOID-9C043A41FF95D41F"]]) {
    const r = await H.verifyIn(label, id); assert.equal(r.state, "verified", `${id}: ${r.text}`); H.noCsp(r);
  }
  const r = await H.verifyIn("Osage.OK", "UNNUMBERED-41938");
  assert.equal(r.state, "notfound", r.text); assert.equal(r.absence, "proven");
});

test("a v2 root that is not posted yet fails (why the roots are posted before the site goes live)", { skip }, async () => {
  H.reset(); H.state.missing.add("Martin.TX");
  const c = C("Martin.TX"), id = JSON.parse(fs.readFileSync(path.join(proofsDir(c), "r/0.json"))).rows[3][0];
  const r = await H.verifyIn("Martin.TX", id);
  assert.equal(r.state, "failed", r.text); assert.match(r.text, /No CountyRoot account was found on-chain/); assert.match(r.text, /may not be posted yet/);
});

test("tampered r/ row fails; a v1-schema on-chain root fails; RPC down falls back to the published fingerprint", { skip }, async () => {
  const c = C("Martin.TX"), id = JSON.parse(fs.readFileSync(path.join(proofsDir(c), "r/2.json"))).rows[11][0];
  H.reset(); H.state.tamper = (p, b) => { if (!/Martin\.TX\.\d+\.2026-10\.proofs\/r\/2\.json$/.test(p)) return b; const j = JSON.parse(b); j.rows[11][3] += 1; return Buffer.from(JSON.stringify(j)); };
  let r = await H.verifyIn("Martin.TX", id); assert.equal(r.state, "failed", r.text);
  H.reset(); H.state.v2schema = SCHEMA_V1;
  r = await H.verifyIn("Martin.TX", id); assert.equal(r.state, "failed", r.text); assert.match(r.text, /fingerprint format/);
  H.reset(); H.state.rpc = "down";
  r = await H.verifyIn("Martin.TX", id); assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "published");
});

test("one parcel in every one of the 212 counties verifies on the v2 site", { skip, timeout: 900000 }, async () => {
  H.reset(); const bad = [];
  for (const c of H.counties) {
    const ix = JSON.parse(fs.readFileSync(path.join(proofsDir(c), "index.json"), "utf8"));
    const k = Math.floor(ix.n_chunks / 2), rows = JSON.parse(fs.readFileSync(path.join(proofsDir(c), `r/${k}.json`))).rows;
    const id = rows[Math.floor(rows.length / 2)][0];
    const r = await H.verifyIn(c.label, id);
    if (r.state !== "verified" || !r.rows.length || !r.rows.every((x) => x.ok === "true")) bad.push(`${c.label} ${id}: ${r.state} ${r.text.slice(0, 120)}`);
    if (r.logs.some((l) => /Content Security Policy|Refused to/i.test(l))) bad.push(`${c.label}: CSP`);
  }
  assert.deepEqual(bad, []);
});

test("page fetched only same-origin URLs (CSP connect-src 'self' held)", { skip }, () => {
  assert.ok(H.state.requests.some((u) => u.startsWith("/packets/")) && H.state.requests.includes("/rpc"));
});
