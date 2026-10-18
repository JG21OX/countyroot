// Shared headless-Chrome harness for the verify page tests: a local server with the site's real CSP (from _headers),
// /packets/* from proof dirs, /rpc (mock CountyRoot accounts, a proxy to Devnet, down, or retracted), and a CDP driver.
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import crypto from "crypto";
import test from "node:test";
import assert from "node:assert/strict";
const discriminatorHex = crypto.createHash("sha256").update("account:CountyRoot").digest().subarray(0, 8).toString("hex");
export const SCHEMA_V1 = "1b0a0a99e80b71583619941720ccd746c9bd03551ca906bcb0a333839b29a427";
export const SCHEMA_V2 = "b309043c77b9aa529244033ecbcaa030615fa949993c835bade21fd2abfbf00d";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream", ".png": "image/png", ".css": "text/css" };

/** pub: built site public dir; proofDirs: dirs searched in order for /packets/*; patch(counties) may edit the county list. */
export async function startHarness({ pub, proofDirs, chrome: CHROME = process.env.CHROME || "google-chrome", patch }) {
  if (typeof WebSocket === "undefined") throw new Error("run with node --experimental-websocket (Node 20) or Node >= 22");
  function headersFor() {
    const txt = fs.readFileSync(path.join(pub, "_headers"), "utf8"), out = {};
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
  const countiesDoc = JSON.parse(fs.readFileSync(path.join(pub, "verify/counties.json"), "utf8"));
  const counties = countiesDoc.counties;
  if (patch) await patch(counties);
  const state = { rpc: "mock", tamper: null, requests: [], packets: "/packets", v2schema: SCHEMA_V2, missing: new Set() };
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
    if (!c || state.missing.has(c.label)) return [200, { jsonrpc: "2.0", id: j.id, result: { context: { slot: 1 }, value: null } }];
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
    let file, roots;
    if (url.pathname.startsWith("/packets/")) {
      const rel = decodeURIComponent(url.pathname.slice(9));
      roots = proofDirs; file = proofDirs.map((d) => path.join(d, rel)).find((f) => fs.existsSync(f)) ?? path.join(proofDirs[0], rel);
    } else { roots = [pub]; file = path.join(pub, decodeURIComponent(url.pathname)); if (url.pathname.endsWith("/")) file = path.join(file, "index.html"); }
    if (!roots.some((r) => file.startsWith(r))) return send(403, "no", "text/plain");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, "not found", "text/plain");
    let body = fs.readFileSync(file);
    if (state.tamper && url.pathname.startsWith("/packets/")) body = state.tamper(url.pathname, body);
    send(200, body, MIME[path.extname(file)] || "application/octet-stream");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
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
  const reset = () => { state.rpc = "mock"; state.tamper = null; state.packets = "/packets"; state.v2schema = SCHEMA_V2; state.missing = new Set(); };
  test.after(async () => {
    const exited = new Promise((r) => chrome.once("exit", r)); chrome.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    server.close(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  });
  return { state, counties, server, ORIGIN, verifyIn, noCsp, reset };
}
