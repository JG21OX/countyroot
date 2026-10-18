// Build a county aliases.json for the verify page: alternate IDs people know (e.g. an appraisal district's
// Property ID) that point to the exact parcel IDs in a packet. Aliases are a lookup convenience only; they are
// NOT in the leaf or the on-chain root, and the proof is always on the packet's parcel ID.
//
//   node scripts/build_aliases.mjs --csv X.csv --pairs pairs.csv --label Travis.TX --type "TCAD Property ID" \
//        [--source <url>] [--note <text>] --out X.aliases.json
//
// pairs.csv: header "alias,target" (target = the ID as the source writes it). Each target is matched to the packet
// exactly first, then by normKey (case, spaces, dashes, dots and leading zeros ignored) if that is unambiguous.
// Only alias -> parcel_id is kept; never put names, addresses or other fields in pairs.csv.
import fs from "fs";
import { pathToFileURL } from "url";
import { loadSdk } from "./verify.mjs";
import { scanRows, loadAllowlist } from "./pii.mjs";
import * as V from "../verifier/cr-verify.js";

export function matchAliases(packetIds, pairs) {
  const exact = new Set(packetIds), byNorm = new Map();
  for (const id of packetIds) { const k = V.normKey(id); if (!byNorm.has(k)) byNorm.set(k, new Set()); byNorm.get(k).add(id); }
  const map = {}, st = { pairs: pairs.length, exact: 0, normalized: 0, ambiguous: 0, unmatched: 0 };
  for (const [alias, target] of pairs) {
    let id = null;
    if (exact.has(target)) { id = target; st.exact++; }
    else { const c = byNorm.get(V.normKey(target)); if (c && c.size === 1) { id = [...c][0]; st.normalized++; } else if (c) st.ambiguous++; else st.unmatched++; }
    if (id === null) continue;
    const a = String(alias).trim(); (map[a] ??= []).includes(id) || map[a].push(id);
  }
  const targets = new Set(Object.values(map).flat());
  st.aliases = Object.keys(map).length; st.packet_ids = exact.size; st.packet_ids_with_alias = targets.size;
  st.packet_coverage = exact.size ? +(targets.size / exact.size).toFixed(6) : 0;
  return { map, stats: st };
}

export async function main(argv, log = console.log) {
  const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const k of ["csv", "pairs", "label", "type", "out"]) if (!a[k]) { log(`missing --${k}`); return 2; }
  const sdk = await loadSdk();
  const ids = sdk.parsePacketCsv(fs.readFileSync(a.csv, "utf8")).map((r) => r.parcel_id);
  const lines = fs.readFileSync(a.pairs, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines[0].replace(/\s/g, "") !== "alias,target") { log("pairs.csv header must be alias,target"); return 2; }
  const pairs = lines.slice(1).map((l) => l.split(",")).filter((p) => p.length === 2 && p[0] && p[1]);
  const { map, stats } = matchAliases(ids, pairs);
  const pii = scanRows(Object.keys(map).map((k) => ({ parcel_id: k })), loadAllowlist());
  if (pii.length) { log(`REFUSED: ${pii.length} alias term(s) look like personal info`); return 1; }
  const doc = { label: a.label, type: { label: a.type, source: a.source ?? null, note: a.note ?? null }, built_at: new Date().toISOString(), stats, map };
  fs.writeFileSync(a.out, JSON.stringify(doc) + "\n");
  log(JSON.stringify(stats));
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main(process.argv.slice(2)).then((c) => process.exit(c));
