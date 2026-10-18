// Personal-info scan over built proof sidecar files (run before uploading them).
//
//   node scripts/scan_proofs.mjs --dir <proofs staging dir> [--forbid-ids-from A.csv[:B.csv]] [--except-ids-from C.csv[:D.csv]]
//
// 1. Every parcel ID and alias term in every s/, x/ and p/ file goes through scripts/pii.mjs (same rules and allowlist as verify/preflight).
// 2. Optional: IDs that appear in --forbid-ids-from (e.g. an unredacted, retracted epoch) but not in --except-ids-from
//    (e.g. the redacted epoch that replaced it) must not appear anywhere. Use this to prove a redaction carried over.
// Only counts and masked IDs are printed. Exit 0 = clean, 1 = hits, 2 = usage error.
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { scanRows, loadAllowlist, maskId } from "./pii.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function* shardFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* shardFiles(p);
    else if (e.isFile() && /\.json$/.test(e.name) && ["s", "x", "p"].includes(path.basename(path.dirname(p)))) yield p;
  }
}
async function idsFromCsvs(list) {
  const { parsePacketCsv } = await import(pathToFileURL(path.join(here, "../sdk/dist/src/index.js")).href);
  const s = new Set();
  for (const f of list) for (const r of parsePacketCsv(fs.readFileSync(f, "utf8"))) s.add(r.parcel_id);
  return s;
}

export async function scanProofs({ dir, forbid = [], except = [] }) {
  const allow = loadAllowlist();
  const deny = new Set(); if (forbid.length) { const ex = await idsFromCsvs(except); for (const id of await idsFromCsvs(forbid)) if (!ex.has(id)) deny.add(id); }
  let files = 0, rows = 0; const pii = [], denied = [];
  for (const f of shardFiles(dir)) {
    files++;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    // s/: rows; x/: alias terms and their target IDs; p/: suggestion IDs (p/index.json: bucket prefixes)
    const ids = j.rows ? j.rows.map((r) => r[0]) : j.entries ? Object.entries(j.entries).flatMap(([t, l]) => [t, ...l.map((x) => x[0])]) : j.ids ? j.ids : j.keys ?? [];
    const rs = ids.map((id) => ({ parcel_id: id }));
    rows += rs.length;
    for (const h of scanRows(rs, allow)) pii.push({ file: path.relative(dir, f), reason: h.reason, masked: h.masked });
    for (const r of rs) if (deny.has(r.parcel_id)) denied.push({ file: path.relative(dir, f), masked: maskId(r.parcel_id) });
  }
  return { files, rows, forbidden_ids: deny.size, pii, denied };
}

export async function main(argv, log = console.log) {
  const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  if (!a.dir) { log("usage: scan_proofs.mjs --dir <dir> [--forbid-ids-from a.csv:b.csv] [--except-ids-from c.csv:d.csv]"); return 2; }
  const split = (v) => (v ? v.split(":").filter(Boolean) : []);
  const r = await scanProofs({ dir: a.dir, forbid: split(a["forbid-ids-from"]), except: split(a["except-ids-from"]) });
  log(`scanned ${r.files} shard files, ${r.rows} rows; personal-info hits: ${r.pii.length}; forbidden-ID hits: ${r.denied.length} (of ${r.forbidden_ids} forbidden IDs)`);
  for (const h of [...r.pii, ...r.denied].slice(0, 20)) log(`  ${h.file} ${h.reason ?? "forbidden"} "${h.masked}"`);
  return r.pii.length || r.denied.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
