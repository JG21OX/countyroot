// Travis.TX: fetch Property ID -> Geographic ID pairs from the official Travis County TNR "TCAD Parcels" layer
// (data from the Travis Central Appraisal District, updated monthly). Requests ONLY the PROP_ID and geo_id fields,
// no geometry, so no owner names or addresses are ever downloaded.
//   node scripts/aliases/travis_tcad.mjs --out tcad-pairs.csv
// then: node scripts/build_aliases.mjs --csv Travis.TX.2.2026-10.csv --pairs tcad-pairs.csv --label Travis.TX \
//         --type "TCAD Property ID" --source <layer url> --out Travis.TX.aliases.json
import fs from "fs";
export const LAYER = "https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD/MapServer/0";
const a = {}; for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!a.out) { console.log("usage: travis_tcad.mjs --out pairs.csv"); process.exit(2); }
const out = ["alias,target"]; let off = 0;
for (;;) {
  const q = new URLSearchParams({ where: "1=1", outFields: "PROP_ID,geo_id", returnGeometry: "false", orderByFields: "OBJECTID", resultOffset: off, resultRecordCount: 1000, f: "json" });
  let d;
  for (let t = 0; t < 5; t++) { try { d = await (await fetch(`${LAYER}/query?${q}`)).json(); if (!d.error) break; } catch {} await new Promise((r) => setTimeout(r, 3000 * (t + 1))); }
  const fs_ = d?.features ?? [];
  for (const f of fs_) {
    const k = Object.keys(f.attributes); if (k.some((x) => x !== "PROP_ID" && x !== "geo_id")) throw new Error("unexpected field");
    const { PROP_ID, geo_id } = f.attributes; if (PROP_ID != null && geo_id && !String(geo_id).includes(",")) out.push(`${PROP_ID},${String(geo_id).trim()}`);
  }
  off += fs_.length;
  if (!fs_.length || (fs_.length < 1000 && !d.exceededTransferLimit)) break;
  await new Promise((r) => setTimeout(r, 150));
}
fs.writeFileSync(a.out, out.join("\n") + "\n");
console.log(`${off} records, ${out.length - 1} pairs -> ${a.out}`);
