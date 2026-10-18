// Leaf format v2 prototype: build a v2 root (and optional v2 proof files) from an existing v1 packet. Local only:
// nothing is posted. The v1 packet is first checked as before (full v1 root rebuild against its root.json and the
// parcel-ID personal-info check), so a v2 root is only ever derived from a packet that matches what is on-chain.
//
//   node scripts/build_v2.mjs --csv X.csv [--root X.root.json] [--epoch N] [--out <dir>] [--chunk 1024] [--compare Y.csv]
//
// --epoch   v2 epoch to bind into the root (default: the v1 epoch + 1, i.e. the next epoch the county would post)
// --out     write <dir>/<label>/<label>.<epoch>.<month>.v2.root.json and the v2 proof files <...>.proofs/ (format 2)
// --compare another packet of the same county: report how many v2 leaves are added/removed/changed/unchanged
// Prints a JSON summary. Exit 0 = built, 1 = refused (packet check failed), 2 = usage/setup error.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { verifyPacket, loadSdk, VerifyError, SetupError } from "./verify.mjs";

export const V2_DEFAULTS = { chunk: 1024 };

export async function v2FromPacket(sdk, csvPath, fips, epoch) {
  const rows = sdk.parsePacketCsv(fs.readFileSync(csvPath, "utf8"));
  const canon = sdk.canonicalRowsV2(rows);
  return { v1rows: rows, tree: sdk.buildTreeV2(fips, epoch, canon) };
}

/** v2 proof files (format 2): index.json, f.json fences, r/<k>.json rows, c/<k>.bin leaves, top.bin. */
export function sidecarV2(sdk, tree, meta, chunk = V2_DEFAULTS.chunk) {
  const n = tree.rows.length, nChunks = Math.ceil(n / chunk), files = new Map(), leaves = tree.levels[0];
  const fences = [];
  for (let k = 0; k < nChunks; k++) {
    const rs = tree.rows.slice(k * chunk, (k + 1) * chunk);
    fences.push(sdk.keyV2(rs[0].id));
    // integers fit JSON numbers exactly (max seen 3.1e13 micro-acres, 1.4e14 centi-sqft, both < 2^53); checked here
    const toNum = (v) => { if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`value ${v} too large for JSON`); return Number(v); };
    files.set(`r/${k}.json`, Buffer.from(JSON.stringify({ format: 2, chunk: k, rows: rs.map((r) => [r.id, r.occ, toNum(r.acresMicro), toNum(r.sqftCenti)]) })));
    files.set(`c/${k}.bin`, Buffer.concat(leaves.slice(k * chunk, (k + 1) * chunk)));
  }
  // chunk-root level and everything above, promote-odd rule (same tree as levels[log2(chunk)..])
  const start = nChunks > 1 ? Math.log2(chunk) : tree.levels.length - 1;
  if (tree.levels[start].length !== nChunks) throw new Error("internal: chunk-root level has the wrong size");
  files.set("top.bin", Buffer.concat(tree.levels.slice(start).flat()));
  files.set("f.json", Buffer.from(JSON.stringify({ format: 2, fences })));
  const index = { format: 2, leaf_version: 2, ...meta, schema: sdk.SCHEMA_V2.toString("hex"), merkle_root: tree.root.toString("hex"),
    n_leaves: n, n_parcels: n, chunk_size: chunk, n_chunks: nChunks,
    leaf: "sha256(0x00 || 'countyroot/leaf/v2' || u32le fips || u16le len || id || u32le occ || u64le acres_micro || u64le sqft_centi)",
    node: "sha256(0x01 || left || right); odd last node promoted", root: "sha256(0x02 || 'countyroot/root/v2' || u32le fips || u32le epoch || u64le n || top)",
    order: "sorted by (normalized key, id, occ); f.json fences = key of the first leaf of each chunk",
    note: "Untrusted layout file. Verify against the on-chain CountyRoot account (schema must be the v2 schema), not against this file." };
  files.set("index.json", Buffer.from(JSON.stringify(index, null, 1) + "\n"));
  return { files, index };
}

/** v2 leaf diff between two packets of one county (leaves don't depend on epoch, so this compares data only). */
export function diffV2(a, b) {
  const m = new Map(a.rows.map((r, i) => [`${r.id}\u0000${r.occ}`, a.levels[0][i]]));
  let unchanged = 0, changed = 0, added = 0;
  b.rows.forEach((r, i) => { const k = `${r.id}\u0000${r.occ}`, l = m.get(k); if (!l) added++; else { if (l.equals(b.levels[0][i])) unchanged++; else changed++; m.delete(k); } });
  return { unchanged, changed, added, removed: m.size };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--") || i + 1 >= argv.length) throw new SetupError(`bad argument ${argv[i]}`);
    a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}
export async function main(argv, log = console.log) {
  try {
    const a = parseArgs(argv);
    if (!a.csv) throw new SetupError("build_v2 needs --csv");
    const sdk = await loadSdk();
    const v = await verifyPacket({ csvPath: a.csv, rootPath: a.root });
    const doc = JSON.parse(fs.readFileSync(v.rootPath, "utf8"));
    const base = path.basename(v.csvPath).replace(/\.csv$/, ""), m = /^(.+)\.(\d+)\.(\d{4}-\d\d)$/.exec(base);
    if (!m) throw new VerifyError(`packet file name ${base}.csv is not <label>.<epoch>.<yyyy-mm>.csv`);
    const epoch = a.epoch ? Number(a.epoch) : doc.epoch + 1;
    const t0 = Date.now();
    const { v1rows, tree } = await v2FromPacket(sdk, v.csvPath, doc.fips, epoch);
    const dupIds = tree.rows.filter((r) => r.occ > 0).length;
    const keyCollisions = (() => { let c = 0; for (let i = 1; i < tree.rows.length; i++) if (sdk.keyV2(tree.rows[i].id) === sdk.keyV2(tree.rows[i - 1].id) && tree.rows[i].id !== tree.rows[i - 1].id) c++; return c; })();
    const summary = { label: m[1], fips: doc.fips, v1_epoch: doc.epoch, v2_epoch: epoch, month: m[3], n_leaves: tree.rows.length,
      v1_root: doc.merkle_root, v2_root: tree.root.toString("hex"), v2_schema: sdk.SCHEMA_V2.toString("hex"),
      rows_with_repeated_id: dupIds, distinct_ids: tree.rows.length - dupIds, ids_sharing_a_key_with_a_different_id: keyCollisions, ms: 0 };
    if (a.compare) {
      const other = await v2FromPacket(sdk, a.compare, doc.fips, epoch);
      summary.compare = { against: path.basename(a.compare), ...diffV2(other.tree, tree) };
      // the same comparison under v1 leaves, for contrast
      // (stored leaf column: older packets such as Travis epoch 1 hashed the text as written, e.g. "18089" not "18089.00")
      const v1a = new Set(other.v1rows.map((r) => (r.leaf ?? sdk.leafHash(r.parcel_id, r.acres, r.lot_sqft).toString("hex")).toLowerCase()));
      summary.compare.v1_leaves_unchanged = sdk.packetLeaves(v1rows).filter((b) => v1a.has(b.toString("hex"))).length;
    }
    if (a.out) {
      const meta = { label: m[1], fips: doc.fips, epoch, month: m[3], packet_file: `${base}.csv`, packet_sha256: crypto.createHash("sha256").update(fs.readFileSync(v.csvPath)).digest("hex") };
      const { files } = sidecarV2(sdk, tree, meta, a.chunk ? Number(a.chunk) : undefined);
      const dir = path.join(a.out, m[1], `${m[1]}.${epoch}.${m[3]}.proofs`);
      fs.rmSync(dir, { recursive: true, force: true });
      for (const [name, buf] of files) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
      const rootDoc = { label: doc.label, fips: doc.fips, epoch, n_parcels: tree.rows.length, merkle_root: tree.root.toString("hex"),
        schema: sdk.SCHEMA_V2_ID, schema_sha256: sdk.SCHEMA_V2.toString("hex"), leaf_version: 2, derived_from: { packet: `${base}.csv`, v1_epoch: doc.epoch, v1_root: doc.merkle_root },
        note: "LOCAL PROTOTYPE. Not posted." };
      fs.writeFileSync(path.join(a.out, m[1], `${m[1]}.${epoch}.${m[3]}.v2.root.json`), JSON.stringify(rootDoc, null, 2) + "\n");
      const sizes = [...files.values()].map((b) => b.length);
      summary.files = files.size; summary.bytes = sizes.reduce((x, y) => x + y, 0); summary.largest = Math.max(...sizes); summary.dir = dir;
    }
    summary.ms = Date.now() - t0;
    log(JSON.stringify(summary));
    return 0;
  } catch (e) {
    if (e instanceof VerifyError) { log(`BUILD REFUSED: ${e.message}`); return 1; }
    log(`ERROR: ${e.message}`); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
