// Audit a v2 build directory (scripts/build_v2.mjs --out <dir>) county by county, from the files alone:
//   node scripts/check_v2.mjs --dir <v2 dir> [--labels A,B] [--jobs 4]
// For each <label>/<label>.<E>.<month>.{csv,root.json,proofs/}:
//   1. SDK: the strict v2 CSV reader rebuilds root.json's root; parcel-ID personal-info check (scripts/verify.mjs);
//   2. browser verifier code (verifier/cr-verify.js) rebuilds the same root from the CSV rows;
//   3. proof files agree with the CSV: index.json (root, n, schema, epoch), r/ rows = CSV rows in order,
//      c/ leaves = the CSV leaf column, f.json fences = first key of each chunk, top.bin = the tree above the chunks;
//   4. personal-info scan over r/ and x/ (scripts/scan_proofs.mjs rules).
// Prints one JSON line per county and a summary. Exit 0 = all OK, 1 = any failure.
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { verifyPacket, loadSdk } from "./verify.mjs";
import { scanProofs } from "./scan_proofs.mjs";
import * as V from "../verifier/cr-verify.js";

export async function checkCounty(dir, label) {
  const sdk = await loadSdk();
  const d = path.join(dir, label), roots = fs.readdirSync(d).filter((f) => f.endsWith(".root.json"));
  if (roots.length !== 1) throw new Error(`${label}: expected one root.json, found ${roots.length}`);
  const rootPath = path.join(d, roots[0]), doc = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  const base = roots[0].replace(/\.root\.json$/, ""), csvPath = path.join(d, `${base}.csv`), pdir = path.join(d, `${base}.proofs`);
  // 1
  const v = await verifyPacket({ csvPath, rootPath });
  if (v.leafVersion !== 2) throw new Error("not a v2 packet");
  const t = v.tree, n = t.rows.length;
  // 2
  const br = await V.rootFromRowsV2(doc.fips, doc.epoch, t.rows.map((r) => [r.id, r.occ, r.acresMicro, r.sqftCenti]));
  if (br.root !== doc.merkle_root) throw new Error(`browser code rebuilds ${br.root}`);
  // 3
  const ix = JSON.parse(fs.readFileSync(path.join(pdir, "index.json"), "utf8"));
  const want = { format: 2, leaf_version: 2, fips: doc.fips, epoch: doc.epoch, merkle_root: doc.merkle_root, n_leaves: n, schema: sdk.SCHEMA_V2.toString("hex") };
  for (const [k, x] of Object.entries(want)) if (ix[k] !== x) throw new Error(`index.json ${k} = ${ix[k]}, expected ${x}`);
  const C = ix.chunk_size, nc = Math.ceil(n / C);
  if (ix.n_chunks !== nc) throw new Error("index.json n_chunks");
  const fences = JSON.parse(fs.readFileSync(path.join(pdir, "f.json"), "utf8")).fences;
  if (fences.length !== nc) throw new Error("f.json length");
  for (let k = 0; k < nc; k++) {
    const rows = JSON.parse(fs.readFileSync(path.join(pdir, `r/${k}.json`), "utf8")).rows, leaves = fs.readFileSync(path.join(pdir, `c/${k}.bin`));
    const lo = k * C, hi = Math.min(n, lo + C);
    if (rows.length !== hi - lo || leaves.length !== (hi - lo) * 32) throw new Error(`chunk ${k} size`);
    if (fences[k] !== sdk.keyV2(t.rows[lo].id)) throw new Error(`fence ${k}`);
    for (let i = lo; i < hi; i++) {
      const r = rows[i - lo], w = t.rows[i];
      if (r[0] !== w.id || r[1] !== w.occ || BigInt(r[2]) !== w.acresMicro || BigInt(r[3]) !== w.sqftCenti) throw new Error(`r/${k}.json row ${i - lo} differs from CSV`);
      if (!leaves.subarray((i - lo) * 32, (i - lo + 1) * 32).equals(t.levels[0][i])) throw new Error(`c/${k}.bin leaf ${i - lo} differs`);
    }
  }
  const start = nc > 1 ? Math.log2(C) : t.levels.length - 1;
  if (!fs.readFileSync(path.join(pdir, "top.bin")).equals(Buffer.concat(t.levels.slice(start).flat()))) throw new Error("top.bin differs");
  // 4
  const s = await scanProofs({ dir: pdir });
  if (s.pii.length) throw new Error(`${s.pii.length} personal-info hits in proof files (first: ${s.pii[0].file} "${s.pii[0].masked}")`);
  const files = (function count(p) { return fs.readdirSync(p, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? count(path.join(p, e.name)) : 1), 0); })(d);
  return { label, ok: true, fips: doc.fips, epoch: doc.epoch, n, root: doc.merkle_root, files, scanned_ids: s.rows };
}

if (!isMainThread) {
  for (const label of workerData.labels) {
    let r; try { r = await checkCounty(workerData.dir, label); } catch (e) { r = { label, ok: false, error: e.message }; }
    parentPort.postMessage(r);
  }
} else if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const a = {}; const av = process.argv.slice(2); for (let i = 0; i < av.length; i += 2) a[av[i].replace(/^--/, "")] = av[i + 1];
  if (!a.dir) { console.log("usage: check_v2.mjs --dir <v2 dir> [--labels A,B] [--jobs 4]"); process.exit(2); }
  const labels = a.labels ? a.labels.split(",") : fs.readdirSync(a.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const jobs = Number(a.jobs ?? 4), size = (l) => fs.statSync(path.join(a.dir, l)).size;
  const groups = Array.from({ length: jobs }, () => []);
  // biggest first, round-robin, so workers finish together
  labels.map((l) => [l, fs.readdirSync(path.join(a.dir, l)).filter((f) => f.endsWith(".csv")).reduce((s, f) => s + fs.statSync(path.join(a.dir, l, f)).size, 0)])
    .sort((x, y) => y[1] - x[1]).forEach(([l], i) => groups[i % jobs].push(l));
  let ok = 0, bad = 0, files = 0, ids = 0;
  await Promise.all(groups.filter((g) => g.length).map((g) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { dir: a.dir, labels: g }, resourceLimits: { maxOldGenerationSizeMb: 12000 } });
    w.on("message", (r) => { console.log(JSON.stringify(r)); if (r.ok) { ok++; files += r.files; ids += r.scanned_ids; } else bad++; });
    w.on("error", rej); w.on("exit", res);
  })));
  console.log(JSON.stringify({ summary: true, counties: labels.length, ok, failed: bad, files, ids_scanned_in_proofs: ids }));
  process.exit(bad || ok !== labels.length ? 1 : 0);
}
