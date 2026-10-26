// Headless Chrome, real CSP: program v2 on the verify page (county head, SUPERSEDED / RETRACTED, provenance, manifest check, history).
//   COUNTYROOT_SITE_V25_PUBLIC=<site built with scripts/site_counties.mjs> COUNTYROOT_V2_DIR=<v2 packets> COUNTYROOT_V1_DIR=<v1 packets>
//   COUNTYROOT_MANIFESTS=<dir of *.manifest.json> [COUNTYROOT_LIVE=1: also read Devnet, read-only] node --experimental-websocket --test verifier/test/page_history.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { startHarness } from "./harness.mjs";

const PUB = process.env.COUNTYROOT_SITE_V25_PUBLIC || "/workspace/site/build-v25/public";
const V2DIR = process.env.COUNTYROOT_V2_DIR || "/workspace/countyroot/stage/v2-all";
const V1DIR = process.env.COUNTYROOT_V1_DIR || "/workspace/countyroot/stage/proofs-all";
const MF = process.env.COUNTYROOT_MANIFESTS || "/tmp/mf-test";
const LIVE = process.env.COUNTYROOT_LIVE === "1";
const cj = path.join(PUB, "verify/counties.json");
const ready = fs.existsSync(cj) && fs.existsSync(V2DIR) && fs.existsSync(V1DIR) && fs.existsSync(MF) && JSON.parse(fs.readFileSync(cj, "utf8")).counties.some((c) => c.head);
const skip = !ready && "no site build with county history / packets / manifests";
// Manifests are served at <packets>/manifests/<file>, as on R2.
const mfRoot = ready ? fs.mkdtempSync(path.join(os.tmpdir(), "cr-mf-")) : null;
if (ready) fs.symlinkSync(path.resolve(MF), path.join(mfRoot, "manifests"));
const H = ready ? await startHarness({ pub: PUB, proofDirs: [V2DIR, V1DIR, mfRoot] }) : null;
const C = (label) => H.counties.find((c) => c.label === label);
const firstId = (c) => JSON.parse(fs.readFileSync(path.join(V2DIR, c.label, `${c.label}.${c.epoch}.${c.month}.proofs`, "r/0.json"))).rows[5][0];
const v1Id = (c, h) => {
  const d = path.join(V1DIR, c.label, `${c.label}.${h.epoch}.${h.month}.proofs`, "s");
  for (const f of fs.readdirSync(d)) { const { rows } = JSON.parse(fs.readFileSync(path.join(d, f))); if (rows?.length) return rows[0][0]; }
};
const older = (c) => c.history.find((h) => h.epoch !== c.epoch && h.proofs);

test("counties.json carries the head PDA, every epoch and the manifest name", { skip }, () => {
  for (const c of H.counties) {
    assert.ok(c.head && c.history.length >= 1 && c.manifest, c.label);
    assert.ok(c.history.some((h) => h.epoch === c.epoch && h.pda === c.pda && h.proofs), c.label);
    assert.ok(fs.existsSync(path.join(MF, c.manifest)), c.manifest);
  }
});

test("mock: current epoch, head current, history lists superseded epochs", { skip }, async () => {
  H.reset();
  const r = await H.verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.equal(r.head, "current");
  assert.deepEqual(r.history.map((h) => h.status), ["active", "superseded", "superseded"]); H.noCsp(r);
});

test("mock: latest epoch retracted → no active root; current epoch RETRACTED banner, rows not trusted", { skip }, async () => {
  H.reset(); H.state.rpc = "retracted"; H.state.head = (c) => ({ latest: c.epoch, latestActive: 0 });
  const r = await H.verifyIn("Osage.OK", "NOID-FF56C03DE20FF661");
  assert.equal(r.head, "no-active"); assert.equal(r.anchor, "onchain-retracted"); assert.notEqual(r.state, "verified", r.text);
  assert.match(r.banners.join(" "), /no active root/); assert.match(r.banners.join(" "), /RETRACTED/); H.noCsp(r);
});

test("mock: Solana has a newer epoch than the site → amber note", { skip }, async () => {
  H.reset(); H.state.head = (c) => ({ latest: c.epoch + 1, latestActive: c.epoch + 1 });
  const r = await H.verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.head, "newer"); assert.match(r.banners.join(" "), /newer epoch/); H.noCsp(r);
});

test("mock: an older (superseded) epoch is checkable and labelled historical", { skip }, async () => {
  H.reset(); const c = C("Adams.CO"), h = older(c);
  const r = await H.verifyIn(c.label, v1Id(c, h), { query: `&e=${h.epoch}` });
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain-superseded"); assert.equal(r.head, "older");
  assert.match(r.banners.join(" "), /SUPERSEDED/); assert.ok(r.epochs.includes(String(h.epoch))); H.noCsp(r);
});

test("mock: history unreadable → amber, the check still runs", { skip }, async () => {
  H.reset(); H.state.failMulti = true;
  const r = await H.verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "verified", r.text); assert.equal(r.head, "unavailable");
});

test("v1-era mock accounts have no provenance record", { skip }, async () => {
  H.reset(); const r = await H.verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.provenance, "none");
});

// ---------------------------------------------------------------- live Devnet (read-only)
const lskip = skip || (!LIVE && "set COUNTYROOT_LIVE=1 to read Devnet");

test("live: Travis current epoch, provenance, manifest matches the chain", { skip: lskip }, async () => {
  H.reset(); H.state.rpc = "live";
  const r = await H.verifyIn("Travis.TX", "0240050817", { query: "&m=1" });
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.equal(r.head, "current");
  assert.equal(r.provenance, "v2"); assert.equal(r.manifest, "ok", r.manifestText);
  assert.deepEqual(r.history.map((h) => h.status), ["active", "superseded", "superseded"]); H.noCsp(r);
});

test("live: Osage shows fetched no later than, history active / superseded / retracted, no check link for the retracted epoch", { skip: lskip }, async () => {
  H.reset(); H.state.rpc = "live";
  const r = await H.verifyIn("Osage.OK", "NOID-FF56C03DE20FF661", { query: "&m=1" });
  assert.equal(r.state, "verified", r.text); assert.equal(r.fetched, "upper-bound"); assert.match(r.fetchedText, /^no later than /);
  assert.equal(r.manifest, "ok", r.manifestText);
  assert.deepEqual(r.history.map((h) => [h.epoch, h.status]), [[3, "active"], [2, "superseded"], [1, "retracted"]]);
  assert.ok(!r.history.find((h) => h.epoch === 1).check); assert.match(r.history.find((h) => h.epoch === 1).text, /do not rely on it/); H.noCsp(r);
});

test("live: a tampered manifest is rejected", { skip: lskip }, async () => {
  H.reset(); H.state.rpc = "live";
  H.state.tamper = (p, b) => (p.includes("/manifests/") ? Buffer.from(b.toString().replace(/"n_parcels":\d+/, '"n_parcels":1')) : b);
  const r = await H.verifyIn("Travis.TX", "0240050817", { query: "&m=1" });
  assert.equal(r.manifest, "bad"); assert.match(r.manifestText, /manifest_sha256/);
});

test("live sample: current (ACTIVE) and earlier (SUPERSEDED) epochs across counties", { skip: lskip }, async () => {
  const all = H.counties.filter((c) => older(c));
  const pick = [...new Set([...["Kings.NY", "MiamiDade.FL", "Adams.CO", "Bexar.TX"].map(C), ...all.filter((_, i) => i % 23 === 0)])].filter(Boolean);
  const seen = { onchain: 0, "onchain-superseded": 0, upper: 0, exact: 0, manifestOk: 0 };
  for (const c of pick) {
    H.reset(); H.state.rpc = "live";
    let r = await H.verifyIn(c.label, firstId(c), { query: "&m=1" });
    assert.equal(r.state, "verified", `${c.label}: ${r.text}`); assert.equal(r.anchor, "onchain", c.label); assert.equal(r.head, "current", c.label);
    assert.equal(r.manifest, "ok", `${c.label}: ${r.manifestText}`); seen.onchain++; seen.manifestOk++; seen[r.fetched === "upper-bound" ? "upper" : "exact"]++;
    const h = older(c);
    if (h) {
      H.reset(); H.state.rpc = "live";
      r = await H.verifyIn(c.label, v1Id(c, h), { query: `&e=${h.epoch}` });
      assert.equal(r.state, "verified", `${c.label} e${h.epoch}: ${r.text}`); assert.equal(r.anchor, "onchain-superseded", c.label); seen["onchain-superseded"]++;
    }
  }
  console.log("live sample", pick.length, "counties", JSON.stringify(seen));
  assert.ok(seen.upper > 0 && seen.exact > 0);
});

test.after(() => { if (mfRoot) fs.rmSync(mfRoot, { recursive: true, force: true }); });
