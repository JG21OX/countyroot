// Headless-Chrome test of the verify page, served with the site's real CSP from a local server.
//   node --experimental-websocket --test verifier/test/    (Node 20; Node >= 22 has WebSocket built in)
// Env: COUNTYROOT_SITE_PUBLIC (built site, default /workspace/site/build/public)
//      COUNTYROOT_PROOFS_DIR  (staged proof files, default /workspace/countyroot/stage/proofs)
//      CHROME (default google-chrome), COUNTYROOT_LIVE_RPC=0 to skip the case that proxies to the real Devnet RPC.
// The local server serves the site, /packets/* from the proofs dir, and /rpc (a mock, or a proxy to Devnet), and
// rewrites /verify/config.json to point at them, so the page runs under the production CSP with connect-src 'self'.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import crypto from "crypto";
const discriminatorHex = crypto.createHash("sha256").update("account:CountyRoot").digest().subarray(0, 8).toString("hex");

const PUB = process.env.COUNTYROOT_SITE_PUBLIC || "/workspace/site/build/public";
const PROOFS = process.env.COUNTYROOT_PROOFS_DIR || "/workspace/countyroot/stage/proofs";
const CHROME = process.env.CHROME || "google-chrome";
const LIVE = process.env.COUNTYROOT_LIVE_RPC !== "0";
if (typeof WebSocket === "undefined") throw new Error("run with node --experimental-websocket (Node 20) or Node >= 22");

// ---- CSP and headers from the built _headers file (the "/*" block) ----
function headersFor() {
  const txt = fs.readFileSync(path.join(PUB, "_headers"), "utf8"), out = {};
  let inAll = false;
  for (const line of txt.split("\n")) {
    if (/^\S/.test(line)) inAll = line.trim() === "/*";
    else if (inAll && line.includes(":")) { const i = line.indexOf(":"); out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  // HSTS / upgrade-insecure-requests would push 127.0.0.1 to https; drop only those for the local test.
  delete out["Strict-Transport-Security"];
  out["Content-Security-Policy"] = out["Content-Security-Policy"].replace(/;\s*upgrade-insecure-requests/, "");
  return out;
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream", ".png": "image/png", ".css": "text/css" };
const countiesDoc = JSON.parse(fs.readFileSync(path.join(PUB, "verify/counties.json"), "utf8"));
const counties = countiesDoc.counties;
// Leaf format v2 prototype: if a local v2 build of Martin.TX exists, the test site lists Martin.TX as its v2 epoch
// (served from COUNTYROOT_V2_DIR) while every other county stays v1, so both formats run side by side.
const V2DIR = process.env.COUNTYROOT_V2_DIR || "/workspace/countyroot/stage/v2";
const SCHEMA_V1 = "1b0a0a99e80b71583619941720ccd746c9bd03551ca906bcb0a333839b29a427";
const SCHEMA_V2 = "b309043c77b9aa529244033ecbcaa030615fa949993c835bade21fd2abfbf00d";
const v2RootFile = fs.existsSync(path.join(V2DIR, "Martin.TX")) ? fs.readdirSync(path.join(V2DIR, "Martin.TX")).find((f) => f.endsWith(".v2.root.json")) : null;
const HAVE_V2 = !!v2RootFile;
if (HAVE_V2) {
  const d = JSON.parse(fs.readFileSync(path.join(V2DIR, "Martin.TX", v2RootFile), "utf8"));
  const { countyRootPda } = await import(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../sdk/dist/src/index.js"));
  const i = counties.findIndex((c) => c.label === "Martin.TX");
  counties[i] = { ...counties[i], epoch: d.epoch, n_parcels: d.n_parcels, merkle_root: d.merkle_root, pda: countyRootPda(d.fips, d.epoch).toBase58(), leaf_version: 2 };
}

const state = { rpc: "mock", tamper: null, requests: [], packets: "/packets", v2schema: SCHEMA_V2 };
function accountB64(c, status = 1) {
  const d = Buffer.alloc(99); Buffer.from(discriminatorHex, "hex").copy(d, 0);
  d.writeUInt32LE(c.fips, 8); d.writeUInt32LE(c.epoch, 12); d.writeBigUInt64LE(BigInt(c.n_parcels), 16);
  Buffer.from(c.merkle_root, "hex").copy(d, 24); Buffer.from(c.leaf_version === 2 ? state.v2schema : SCHEMA_V1, "hex").copy(d, 56); d[88] = status; d.writeBigInt64LE(1792000000n, 89); d[97] = 255; d[98] = 1;
  return d.toString("base64");
}
async function rpc(req, body) {
  const j = JSON.parse(body), pda = j.params?.[0];
  if (state.rpc === "down") return [503, { error: "down" }];
  if (state.rpc === "live") {
    const r = await fetch("https://api.devnet.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body });
    return [r.status, await r.json()];
  }
  const c = counties.find((x) => x.pda === pda);
  if (!c) return [200, { jsonrpc: "2.0", id: j.id, result: { context: { slot: 1 }, value: null } }];
  return [200, { jsonrpc: "2.0", id: j.id, result: { context: { slot: 1 }, value: { owner: "7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg", data: [accountB64(c, state.rpc === "retracted" ? 2 : 1), "base64"], lamports: 1, executable: false } } }];
}
const server = http.createServer(async (req, res) => {
  const hdrs = headersFor(), url = new URL(req.url, "http://x");
  state.requests.push(url.pathname);
  const send = (code, body, type) => { res.writeHead(code, { ...hdrs, "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
  if (url.pathname === "/rpc") {
    let b = ""; req.on("data", (d) => (b += d)); await new Promise((r) => req.on("end", r));
    const [code, j] = await rpc(req, b); return send(code, JSON.stringify(j), "application/json");
  }
  if (url.pathname === "/verify/counties.json") return send(200, JSON.stringify({ ...countiesDoc, counties }), "application/json");
  if (url.pathname === "/verify/config.json") return send(200, JSON.stringify({ rpc: "/rpc", packets: state.packets, cluster: "devnet" }), "application/json");
  let file;
  if (url.pathname.startsWith("/packets/")) {
    const rel = decodeURIComponent(url.pathname.slice(9));
    file = path.join(PROOFS, rel);
    if (HAVE_V2 && !fs.existsSync(file) && fs.existsSync(path.join(V2DIR, rel))) file = path.join(V2DIR, rel);
  }
  else { file = path.join(PUB, decodeURIComponent(url.pathname)); if (url.pathname.endsWith("/")) file = path.join(file, "index.html"); }
  if (!file.startsWith(PUB) && !file.startsWith(PROOFS) && !file.startsWith(V2DIR)) return send(403, "no", "text/plain");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, "not found", "text/plain");
  let body = fs.readFileSync(file);
  if (state.tamper && url.pathname.startsWith("/packets/")) body = state.tamper(url.pathname, body);
  send(200, body, MIME[path.extname(file)] || "application/octet-stream");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---- minimal CDP driver ----
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cr-chrome-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let port; for (let i = 0; i < 100 && !port; i++) { await new Promise((r) => setTimeout(r, 100)); try { port = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {} }
if (!port) throw new Error("Chrome did not start");

async function openPage(url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(), logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === "Log.entryAdded") logs.push(msg.params.entry.text);
    if (msg.method === "Runtime.consoleAPICalled") logs.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Page.navigate", { url });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
  return { evalJs, logs, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); } };
}
async function verifyIn(label, parcel, { timeout = 60000 } = {}) {
  const p = await openPage(`${ORIGIN}/verify/?c=${encodeURIComponent(label)}&p=${encodeURIComponent(parcel)}`);
  const t0 = Date.now(); let st;
  while (Date.now() - t0 < timeout) {
    st = await p.evalJs("document.getElementById('out') && document.getElementById('out').dataset.state");
    if (st && st !== "idle" && st !== "running") break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const info = await p.evalJs(`JSON.stringify({ state: document.getElementById('out').dataset.state,
    anchor: (document.querySelector('[data-anchor]')||{}).dataset?.anchor || null,
    rows: [...document.querySelectorAll('.result')].map(e => ({ ok: e.dataset.ok, row: e.dataset.row, verdict: e.querySelector('.verdict').textContent })),
    status: document.getElementById('status').textContent,
    resolved: (document.querySelector('[data-resolved]')||{dataset:{}}).dataset.resolved || null,
    matched: (document.querySelector('[data-resolved]')||{dataset:{}}).dataset.matched || null,
    parcels: [...document.querySelectorAll('.result dd:first-of-type')].map(e => e.textContent),
    suggestions: [...document.querySelectorAll('[data-sugg]')].map(e => ({ id: e.dataset.sugg, href: e.getAttribute('href') })),
    absence: (document.querySelector('[data-absence]')||{dataset:{}}).dataset.absence || null,
    hint: (document.getElementById('hint')||{}).textContent || '', text: document.getElementById('out').innerText.slice(0, 600) })`);
  const r = { ...JSON.parse(info), ms: Date.now() - t0, logs: p.logs.slice() };
  await p.close();
  return r;
}
const noCsp = (r) => assert.ok(!r.logs.some((l) => /Content Security Policy|Refused to/i.test(l)), "CSP violations: " + r.logs.join(" | "));
const reset = () => { state.rpc = "mock"; state.tamper = null; state.packets = "/packets"; state.v2schema = SCHEMA_V2; };

test.after(async () => {
  const exited = new Promise((r) => chrome.once("exit", r)); chrome.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  server.close(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
});

test("Travis.TX: a parcel verifies against the root (mock RPC)", async () => {
  reset(); const r = await verifyIn("Travis.TX", "0000000ROW");
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.equal(r.rows.length, 1); assert.equal(r.rows[0].row, "3"); noCsp(r);
});

test("Travis.TX: live Devnet RPC (proxied same-origin) verifies against the real on-chain root", { skip: !LIVE }, async () => {
  reset(); state.rpc = "live"; const r = await verifyIn("Travis.TX", " 000000park ");
  assert.equal(r.state, "verified", r.text); assert.equal(r.anchor, "onchain"); assert.match(r.rows[0].verdict, /Verified on-chain/); noCsp(r);
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
const v2skip = !HAVE_V2 && "no local v2 build (node scripts/build_v2.mjs --csv Martin.TX.1.2026-10.csv --out stage/v2)";
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
