#!/usr/bin/env node
// Add on-chain history to the site's verify/counties.json (read-only; sends nothing).
//   node scripts/site_counties.mjs --in <counties.json> --out <counties.json> [--proofs <stage dir> ...] [--manifests <dir>] [--cluster devnet|<url>]
// Per county it adds:
//   head      CountyHead PDA ["county_head", fips]   (the browser can't derive PDAs)
//   history   [{ epoch, pda, month, n_parcels, merkle_root, leaf_version, proofs, manifest }] for epochs 1..head.latest_epoch,
//             read from the chain. proofs = true only when that epoch's proof sidecar exists in a --proofs dir
//             (<dir>/<label>/<label>.<epoch>.<month>.proofs/index.json) AND the epoch is not RETRACTED, so the page
//             never offers a check against retracted data.
//   manifest  file name of the current epoch's manifest (<key>.<fips5>.e<N>.manifest.json), served at <packets>/manifests/.
//             With --manifests, a county whose manifest file is missing there is an error.
// Counties without a head on-chain are left as they are (no head/history fields).
import fs from "fs";
import path from "path";
import { loadSdk } from "./verify.mjs";
import { manifestFileName } from "./migrate_v2.mjs";
import { fetchAccounts, decodeCountyHead, decodeCountyRoot, STATUS_RETRACTED } from "../verifier/cr-verify.js";

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const many = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const IN = opt("--in"), OUT = opt("--out"), PROOFS = many("--proofs"), MANIFESTS = opt("--manifests");
const cl = opt("--cluster") || "devnet";
if (/mainnet/.test(cl)) throw new Error("mainnet is refused");
const RPC = cl === "devnet" ? "https://api.devnet.solana.com" : cl === "localnet" ? "http://127.0.0.1:8899" : cl;
if (!IN || !OUT) { console.error("usage: --in <counties.json> --out <counties.json> [--proofs dir]... [--manifests dir] [--cluster devnet|url]"); process.exit(2); }

const sdk = await loadSdk();
const counties = JSON.parse(fs.readFileSync(IN, "utf8"));
const list = Array.isArray(counties) ? counties : counties.counties;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function accounts(addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 100) {
    for (let t = 0; ; t++) {
      try { out.push(...(await fetchAccounts(RPC, addrs.slice(i, i + 100), { timeoutMs: 20000 }))); break; }
      catch (e) { if (t >= 5 || /not owned/.test(e.message)) throw e; await sleep(1000 * 2 ** t); }
    }
  }
  return out;
}
function proofMonth(label, epoch) {
  for (const d of PROOFS) {
    const dir = path.join(d, label);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+)\.(\d+)\.(\d{4}-\d{2})\.proofs$/);
      if (m && m[1] === label && Number(m[2]) === epoch && fs.existsSync(path.join(dir, f, "index.json"))) return m[3];
    }
  }
  return null;
}

const heads = list.map((c) => sdk.countyHeadPda(c.fips).toBase58());
const headAccts = await accounts(heads);
const want = [];
list.forEach((c, i) => {
  if (!headAccts[i]) return;
  const h = decodeCountyHeadSync(headAccts[i].data);
  for (let e = 1; e <= h.latestEpoch; e++) want.push({ i, epoch: e, pda: sdk.countyRootPda(c.fips, e).toBase58() });
});
function decodeCountyHeadSync(d) { const dv = new DataView(d.buffer, d.byteOffset, d.byteLength); return { fips: dv.getUint32(8, true), latestEpoch: dv.getUint32(12, true) }; }
const rootAccts = await accounts(want.map((w) => w.pda));

let nHist = 0, missingMf = [];
for (let i = 0; i < list.length; i++) {
  const c = list[i];
  if (!headAccts[i]) { console.warn(`${c.label}: no county head on-chain; left unchanged`); continue; }
  const h = await decodeCountyHead(headAccts[i].data);
  if (h.fips !== c.fips) throw new Error(`${c.label}: head fips ${h.fips}`);
  if (h.latestEpoch !== c.epoch) console.warn(`${c.label}: head latest_epoch ${h.latestEpoch}, site lists epoch ${c.epoch}`);
  c.head = heads[i];
  c.history = [];
  for (const [k, w] of want.entries()) {
    if (w.i !== i || !rootAccts[k]) continue;
    const a = await decodeCountyRoot(rootAccts[k].data);
    if (a.fips !== c.fips || a.epoch !== w.epoch) throw new Error(`${c.label}: ${w.pda} is fips ${a.fips} epoch ${a.epoch}`);
    const month = w.epoch === c.epoch ? c.month : proofMonth(c.label, w.epoch);
    const e = { epoch: w.epoch, pda: w.pda, month, n_parcels: Number(a.nParcels), merkle_root: a.merkleRoot,
                leaf_version: w.epoch === c.epoch ? (c.leaf_version || 1) : (a.version >= 2 ? a.leafVersion : (proofLeafVersion(c.label, w.epoch, month) ?? 1)),
                proofs: w.epoch === c.epoch || (!!month && a.status !== STATUS_RETRACTED),
                manifest: a.manifestSha256 ? manifestFileName(c.label, c.fips, w.epoch) : null };
    c.history.push(e); nHist++;
  }
  const cur = c.history.find((e) => e.epoch === c.epoch);
  c.manifest = cur?.manifest ?? null;
  if (MANIFESTS && c.manifest && !fs.existsSync(path.join(MANIFESTS, c.manifest))) missingMf.push(c.manifest);
}
function proofLeafVersion(label, epoch, month) {
  if (!month) return null;
  for (const d of PROOFS) {
    const f = path.join(d, label, `${label}.${epoch}.${month}.proofs`, "index.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).leaf_version === 2 ? 2 : 1;
  }
  return null;
}
if (missingMf.length) throw new Error(`manifests missing from ${MANIFESTS}: ${missingMf.slice(0, 5).join(", ")}${missingMf.length > 5 ? ` (+${missingMf.length - 5})` : ""}`);
fs.writeFileSync(OUT, JSON.stringify(counties));
console.log(`${list.length} counties, ${list.filter((c) => c.head).length} with a head, ${nHist} epochs; ${list.reduce((n, c) => n + (c.history || []).filter((e) => e.epoch !== c.epoch && e.proofs).length, 0)} older epochs checkable`);
