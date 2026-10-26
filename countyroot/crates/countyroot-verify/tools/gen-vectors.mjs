// Regenerates tests/fixtures/*.json from the TypeScript reference (sdk/src/leafv2.ts).
// Usage (from countyroot/): (cd sdk && npm run build) && node crates/countyroot-verify/tools/gen-vectors.mjs [packet-dir]
// packet-dir holds <Label>.<epoch>.<month>.csv v2 packets for the real-proof fixtures (optional).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = process.env.CR_SDK_DIST ?? path.join(here, "../../../sdk/dist/src");
const L = await import(path.join(sdk, "leafv2.js"));
const out = path.join(here, "../tests/fixtures");

// Deterministic PRNG so the vectors are reproducible.
let s = 0x2026_1026n;
const rnd = (m) => { s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number((s >> 33n) % BigInt(m)); };
const idChars = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ-. ";
function randRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    let len = 1 + rnd(14); let id = "";
    for (let j = 0; j < len; j++) id += idChars[rnd(idChars.length - (j === 0 || j === len - 1 ? 1 : 0))];
    id = id.trim() || "0";
    rows.push({ id, occ: 0, acresMicro: BigInt(rnd(1e9)), sqftCenti: BigInt(rnd(1e9)) });
  }
  // occurrence numbers for repeated ids, then canonical order
  rows.sort(L.compareRowsV2);
  const seen = new Map(); for (const r of rows) { const k = r.id; r.occ = seen.get(k) ?? 0; seen.set(k, r.occ + 1); }
  rows.sort(L.compareRowsV2);
  return rows;
}
const rowJson = (r) => ({ id: r.id, occ: r.occ, acres_micro: r.acresMicro.toString(), sqft_centi: r.sqftCenti.toString() });

const synth = { schema_v2: L.SCHEMA_V2.toString("hex"), leaves: [], trees: [] };
// leaf vectors, including edge values
const edge = [
  { id: "0", occ: 0, acresMicro: 0n, sqftCenti: 0n },
  { id: "12601-01-01", occ: 3, acresMicro: 415276n, sqftCenti: 1808900n },
  { id: "~".repeat(256), occ: 0xffffffff, acresMicro: L.NOT_PROVIDED, sqftCenti: L.NOT_PROVIDED },
  { id: "A B", occ: 1, acresMicro: 1n, sqftCenti: 2n },
];
for (const [fips, r] of [[48453, edge[0]], [40113, edge[1]], [99999, edge[2]], [6037, edge[3]]])
  synth.leaves.push({ fips, row: rowJson(r), leaf: L.leafHashV2(fips, r).toString("hex") });
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 33, 100, 1000]) {
  const fips = 90000 + n, epoch = 1 + (n % 5);
  const t = L.buildTreeV2(fips, epoch, randRows(n));
  const idx = [...new Set([0, n - 1, n >> 1, Math.max(0, n - 2), rnd(n)])].filter((i) => i >= 0 && i < n);
  const proofs = idx.map((i) => L.makeProofV2(t, i));
  for (const p of proofs) if (!L.verifyProofV2(p, t.root)) throw new Error("reference proof failed");
  synth.trees.push({ fips, epoch, n_leaves: n, top: t.top.toString("hex"), root: t.root.toString("hex"), proofs });
}
fs.writeFileSync(path.join(out, "vectors.json"), JSON.stringify(synth, null, 1) + "\n");
console.log("vectors.json:", synth.leaves.length, "leaves,", synth.trees.length, "trees");

const dir = process.argv[2];
if (dir) {
  const real = {};
  for (const [label, fips, epoch] of [["Travis.TX", 48453, 3], ["Osage.OK", 40113, 3], ["LosAngeles.CA", 6037, 2]]) {
    const f = fs.readdirSync(path.join(dir, label)).find((x) => x.startsWith(`${label}.${epoch}.`) && x.endsWith(".csv"));
    const t = L.treeFromCsvV2(fips, epoch, fs.readFileSync(path.join(dir, label, f), "utf8"));
    const n = t.rows.length;
    let longest = 0; t.rows.forEach((r, i) => { if (r.id.length > t.rows[longest].id.length) longest = i; });
    const dup = t.rows.findIndex((r) => r.occ > 0);
    const idx = [...new Set([0, n - 1, n >> 1, longest, ...(dup >= 0 ? [dup] : [])])];
    const proofs = idx.map((i) => L.makeProofV2(t, i));
    for (const p of proofs) if (!L.verifyProofV2(p, t.root)) throw new Error("real proof failed");
    real[label] = { fips, epoch, n_leaves: n, root: t.root.toString("hex"), packet: f, proofs };
    console.log(label, "n =", n, "root", t.root.toString("hex").slice(0, 16), "proofs", idx.length, "max siblings", Math.max(...proofs.map((p) => p.siblings.length)));
  }
  fs.writeFileSync(path.join(out, "real-proofs.json"), JSON.stringify(real, null, 1) + "\n");
}
