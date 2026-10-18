// Leaf format v2 (docs/leaf-v2.md): build a county's v2 packet from its current v1 packet. Local only: nothing is posted.
//
//   node scripts/build_v2.mjs --csv X.csv [--root X.root.json] --out <dir> [--rpc devnet|<url> | --offline 1]
//        [--epoch N] [--noid noid_map.json] [--aliases A.aliases.json] [--chunk 1024] [--sample N|all] [--compare Y.csv]
//
// Writes, under <out>/<label>/ (same key layout as R2):
//   <label>.<E>.<month>.csv        v2 packet: parcel_id,occ,acres_micro,sqft_centi,leaf, one row per leaf, in leaf order
//   <label>.<E>.<month>.root.json  fips, epoch E, n_parcels, merkle_root, schema (v2), leaf_version 2, supersedes_epoch
//   <label>.<E>.<month>.proofs/    proof files, format 2 (index.json, f.json, r/, c/, top.bin, optional x/ aliases)
// E defaults to the v1 epoch + 1. Output is deterministic (no timestamps), so two builds can be compared byte for byte.
//
// Safety, in order: the v1 packet is checked (full v1 root rebuild against its root.json + parcel-ID personal-info
// check); with --rpc (default devnet) the v1 account must be ACTIVE on-chain with the same root, count and v1 schema,
// and epoch E must be unused (or already hold exactly this v2 root); NOID replacements (--noid) are re-hashed from
// their canonical public geometry; no UNNUMBERED-<line> ID may remain; the v2 CSV is re-read and must rebuild the
// root; the root is rebuilt again with the browser verifier's code; sampled proofs are assembled from the proof
// files and must equal the SDK's. --compare: v2 leaf diff against another packet of the county.
// Prints a JSON summary. Exit 0 = built, 1 = refused, 2 = usage/setup error.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { verifyPacket, loadSdk, VerifyError, SetupError } from "./verify.mjs";
import { buildLookup, loadAliases } from "./build_proofs.mjs";
import * as V from "../verifier/cr-verify.js";

export const V2_DEFAULTS = { chunk: 1024 };

export async function v2FromPacket(sdk, csvPath, fips, epoch) {
  const rows = sdk.parsePacketCsv(fs.readFileSync(csvPath, "utf8"));
  const canon = sdk.canonicalRowsV2(rows);
  return { v1rows: rows, tree: sdk.buildTreeV2(fips, epoch, canon) };
}

/** v2 proof files (format 2): index.json, f.json fences, r/<k>.json rows, c/<k>.bin leaves, top.bin. */
export function sidecarV2(sdk, tree, meta, chunk = V2_DEFAULTS.chunk, aliases = []) {
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
  // county aliases only (normalized IDs and prefix suggestions come from the key order itself in v2)
  let lk = null;
  if (aliases.length) { lk = buildLookup({ rows: tree.rows.map((r) => ({ parcel_id: r.id })), aliases, normalized: false, prefix: false }); for (const [k, b] of lk.files) files.set(k, b); }
  const index = { format: 2, leaf_version: 2, ...meta, schema: sdk.SCHEMA_V2.toString("hex"), merkle_root: tree.root.toString("hex"),
    n_leaves: n, n_parcels: n, chunk_size: chunk, n_chunks: nChunks,
    leaf: "sha256(0x00 || 'countyroot/leaf/v2' || u32le fips || u16le len || id || u32le occ || u64le acres_micro || u64le sqft_centi)",
    node: "sha256(0x01 || left || right); odd last node promoted", root: "sha256(0x02 || 'countyroot/root/v2' || u32le fips || u32le epoch || u64le n || top)",
    order: "sorted by (normalized key, id, occ); f.json fences = key of the first leaf of each chunk",
    ...(lk ? { n_xshards: lk.n_xshards, alias_types: lk.alias_types, lookup_note: "x/ holds county aliases (a lookup aid, not part of the leaf or the root)" } : {}),
    note: "Untrusted layout file. Verify against the on-chain CountyRoot account (schema must be the v2 schema), not against this file." };
  files.set("index.json", Buffer.from(JSON.stringify(index, null, 1) + "\n"));
  return { files, index, lookup: lk };
}

/** v2 leaf diff between two packets of one county (leaves don't depend on epoch, so this compares data only). */
export function diffV2(a, b) {
  const m = new Map(a.rows.map((r, i) => [`${r.id}\u0000${r.occ}`, a.levels[0][i]]));
  let unchanged = 0, changed = 0, added = 0;
  b.rows.forEach((r, i) => { const k = `${r.id}\u0000${r.occ}`, l = m.get(k); if (!l) added++; else { if (l.equals(b.levels[0][i])) unchanged++; else changed++; m.delete(k); } });
  return { unchanged, changed, added, removed: m.size };
}

const NOID_TAG = Buffer.from("countyroot/geom/v1", "ascii");
/** NOID = "NOID-" + first 16 hex (upper) of sha256(tag || 0x00 || u32le fips || canonical geometry text); see docs/leaf-v2.md. */
export function noidOf(fips, canonical) {
  const f = Buffer.alloc(4); f.writeUInt32LE(fips);
  return "NOID-" + crypto.createHash("sha256").update(Buffer.concat([NOID_TAG, Buffer.from([0]), f, Buffer.from(canonical, "ascii")])).digest("hex").slice(0, 16).toUpperCase();
}
/** Apply NOID replacements for this county; every entry must hit exactly one row and re-hash to its NOID. */
export function applyNoids(rows, fips, entries) {
  const out = [];
  for (const e of entries.filter((x) => x.fips === fips)) {
    if (!/^NOID-[0-9A-F]{16}$/.test(e.noid)) throw new VerifyError(`bad NOID ${e.noid}`);
    if (e.method !== "geometry" || typeof e.canonical_geometry !== "string") throw new VerifyError(`${e.old_id}: NOID entry has no canonical geometry`);
    if (noidOf(fips, e.canonical_geometry) !== e.noid) throw new VerifyError(`${e.old_id}: ${e.noid} does not re-hash from its canonical geometry`);
    const hit = rows.filter((r) => r.parcel_id === e.old_id);
    if (hit.length !== 1) throw new VerifyError(`${e.old_id}: expected exactly 1 row, found ${hit.length}`);
    if (rows.some((r) => r.parcel_id === e.noid)) throw new VerifyError(`${e.noid} already present`);
    hit[0].parcel_id = e.noid;
    out.push({ from: e.old_id, to: e.noid, rule: "NOID (docs/leaf-v2.md)", source_layer: e.source_layer, source_objectid: e.objectid, canonical_geometry_sha256: crypto.createHash("sha256").update(e.canonical_geometry).digest("hex") });
  }
  const left = rows.filter((r) => /^UNNUMBERED-/.test(r.parcel_id));
  if (left.length) throw new VerifyError(`${left.length} UNNUMBERED-<line> ID(s) without a NOID (give --noid)`);
  return out;
}

const rpcUrl = (v) => (v.startsWith("http") ? v : clusterApiUrl(v === "mainnet" ? "mainnet-beta" : v));
/** On-chain gate: v1 epoch ACTIVE with this root/count/v1 schema; v2 epoch unused (or already this exact v2 root). */
export async function chainCheck(sdk, conn, doc, epoch, v2root, n) {
  const a = await sdk.fetchCountyRoot(conn, doc.fips, doc.epoch, "confirmed");
  if (!a) throw new VerifyError(`no on-chain account for fips ${doc.fips} epoch ${doc.epoch}`);
  if (a.status !== sdk.STATUS_ACTIVE) throw new VerifyError(`fips ${doc.fips} epoch ${doc.epoch} is not ACTIVE on-chain`);
  if (a.merkleRoot.toString("hex") !== doc.merkle_root || a.nParcels !== BigInt(doc.n_parcels)) throw new VerifyError(`on-chain epoch ${doc.epoch} root/count differ from the v1 packet`);
  if (!Buffer.from(a.schema).equals(sdk.SCHEMA_V1)) throw new VerifyError(`on-chain epoch ${doc.epoch} schema is not the v1 schema`);
  const pda = sdk.countyRootPda(doc.fips, epoch), info = await conn.getAccountInfo(pda, "confirmed");
  if (info) {
    const b = sdk.decodeCountyRoot(info.data);
    if (b.merkleRoot.toString("hex") === v2root && b.nParcels === BigInt(n) && Buffer.from(b.schema).equals(sdk.SCHEMA_V2) && b.status === sdk.STATUS_ACTIVE) return { v1: "active", v2: "posted" };
    throw new VerifyError(`fips ${doc.fips} epoch ${epoch} already exists on-chain with different contents; pick another epoch`);
  }
  if ((await conn.getSignaturesForAddress(pda, { limit: 1 }, "confirmed")).length) throw new VerifyError(`fips ${doc.fips} epoch ${epoch} was closed on-chain; never reuse it`);
  return { v1: "active", v2: "unposted" };
}

/** Rows to self-check: ends, middle, both sides of up to 64 evenly spread chunk boundaries, and m deterministic random rows. */
export function sampleV2(n, m, chunk) {
  const s = new Set([0, 1, n - 1, n - 2, Math.floor(n / 2)].filter((x) => x >= 0 && x < n));
  const nc = Math.ceil(n / chunk), step = Math.max(1, Math.floor(nc / 64));
  for (let k = 1; k < nc; k += step) { s.add(k * chunk - 1); s.add(k * chunk); }
  if (nc > 1) { s.add((nc - 1) * chunk - 1); s.add((nc - 1) * chunk); }
  const target = Math.min(n, s.size + m); let x = 12345;
  for (let t = 0; s.size < target && t < 50 * target; t++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; s.add((x >>> 0) % n); }
  return [...s].sort((a, b) => a - b);
}

export async function buildV2({ csvPath, rootPath, outDir, epoch, rpc = "devnet", offline = false, noidFile, aliasFiles = [], chunk, sample = 256, compare }) {
  const sdk = await loadSdk();
  const v = await verifyPacket({ csvPath, rootPath });
  if (v.leafVersion === 2) throw new VerifyError("input is already a v2 packet");
  const doc = JSON.parse(fs.readFileSync(v.rootPath, "utf8"));
  const base = path.basename(v.csvPath).replace(/\.csv$/, ""), m = /^(.+)\.(\d+)\.(\d{4}-\d\d)$/.exec(base);
  if (!m) throw new VerifyError(`packet file name ${base}.csv is not <label>.<epoch>.<yyyy-mm>.csv`);
  const [, label, , month] = m;
  epoch = epoch ?? doc.epoch + 1;
  if (!(epoch > doc.epoch)) throw new VerifyError(`v2 epoch ${epoch} must be after the v1 epoch ${doc.epoch}`);
  const t0 = Date.now();
  const csvBytes = fs.readFileSync(v.csvPath);
  const rows = sdk.parsePacketCsv(csvBytes.toString("utf8"));
  const replacements = applyNoids(rows, doc.fips, noidFile ? JSON.parse(fs.readFileSync(noidFile, "utf8")) : []);
  const tree = sdk.buildTreeV2(doc.fips, epoch, sdk.canonicalRowsV2(rows));
  const v2root = tree.root.toString("hex"), n = tree.rows.length;
  // 1. the v2 CSV must rebuild the same root (SDK reader)
  const csvText = sdk.packetCsvV2(tree);
  if (!sdk.treeFromCsvV2(doc.fips, epoch, csvText).root.equals(tree.root)) throw new Error("internal: v2 CSV does not rebuild the root");
  // 2. the browser verifier's code must rebuild it too
  const br = await V.rootFromRowsV2(doc.fips, epoch, tree.rows.map((r) => [r.id, r.occ, r.acresMicro, r.sqftCenti]));
  if (br.root !== v2root) throw new Error(`browser verifier code rebuilds ${br.root}, SDK ${v2root}`);
  let onchain = null;
  if (!offline) onchain = await chainCheck(sdk, new Connection(rpcUrl(rpc), "confirmed"), doc, epoch, v2root, n);
  const outBase = `${label}.${epoch}.${month}`;
  const meta = { label, fips: doc.fips, epoch, month, pda: sdk.countyRootPda(doc.fips, epoch).toBase58(), program: V.PROGRAM_ID,
                 packet_file: `${outBase}.csv`, packet_sha256: crypto.createHash("sha256").update(csvText).digest("hex") };
  const aliases = aliasFiles.map((f) => loadAliases(f, label));
  const { files, index, lookup } = sidecarV2(sdk, tree, meta, chunk ?? V2_DEFAULTS.chunk, aliases);
  // 3. sampled proofs, assembled from the proof files exactly as the browser does, must equal the SDK's and verify
  const idx = sample === 0 || sample >= n ? [...Array(n).keys()] : sampleV2(n, sample, index.chunk_size);
  const top = new Uint8Array(files.get("top.bin"));
  for (const i of idx) {
    const k = Math.floor(i / index.chunk_size), r = tree.rows[i];
    const leaf = await V.leafHashV2(doc.fips, r.id, r.occ, r.acresMicro, r.sqftCenti);
    const got = await V.assembleProofV2({ leaf, index: i, nLeaves: n, chunkSize: index.chunk_size, chunkBytes: new Uint8Array(files.get(`c/${k}.bin`)), topBytes: top });
    const want = sdk.makeProofV2(tree, i);
    if (got.siblings.join() !== want.siblings.join()) throw new Error(`self-check: proof for leaf ${i} differs from the SDK`);
    if (!sdk.verifyProofV2(want, tree.root)) throw new Error(`self-check: SDK rejects proof ${i}`);
    const row = JSON.parse(files.get(`r/${k}.json`)).rows[i % index.chunk_size];
    if (row[0] !== r.id || row[1] !== r.occ || BigInt(row[2]) !== r.acresMicro || BigInt(row[3]) !== r.sqftCenti) throw new Error(`self-check: r/${k}.json row ${i} differs`);
  }
  const rootDoc = { label: doc.label, fips: doc.fips, epoch, n_parcels: n, merkle_root: v2root, schema: sdk.SCHEMA_V2_ID, schema_sha256: sdk.SCHEMA_V2.toString("hex"),
    leaf_version: 2, posted_at: null, pda: meta.pda, supersedes_epoch: doc.epoch,
    derived_from: { packet: `${base}.csv`, packet_sha256: crypto.createHash("sha256").update(csvBytes).digest("hex"), v1_epoch: doc.epoch, v1_root: doc.merkle_root },
    ...(replacements.length ? { id_replacements: replacements } : {}),
    note: `Same parcels as epoch ${doc.epoch}, fingerprinted in leaf format v2 (docs/leaf-v2.md: one leaf per row with a repeat number, integer units, sorted by normalized ID, fips/epoch/count bound into the root)${replacements.length ? `; ${replacements.length} UNNUMBERED-<line> ID(s) replaced by NOID-<hash of the public parcel outline>` : ""}.` };
  const dir = path.join(outDir, label), pdir = path.join(dir, `${outBase}.proofs`);
  fs.mkdirSync(dir, { recursive: true }); fs.rmSync(pdir, { recursive: true, force: true });
  for (const [name, buf] of files) { const p = path.join(pdir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  fs.writeFileSync(path.join(dir, `${outBase}.csv`), csvText);
  fs.writeFileSync(path.join(dir, `${outBase}.root.json`), JSON.stringify(rootDoc, null, 2) + "\n");
  // 4. re-read what was written through the normal packet check (v2 path: strict CSV, PII, root)
  const back = await verifyPacket({ csvPath: path.join(dir, `${outBase}.csv`) });
  if (back.root !== v2root) throw new Error("internal: written v2 packet does not verify");
  const sizes = [...files].map(([k, b]) => [k, b.length]), big = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
  const dupIds = tree.rows.filter((r) => r.occ > 0).length;
  const summary = { label, fips: doc.fips, v1_epoch: doc.epoch, v2_epoch: epoch, month, n_leaves: n, v1_root: doc.merkle_root, v2_root: v2root, onchain,
    rows_with_repeated_id: dupIds, id_replacements: replacements.map((r) => `${r.from} -> ${r.to}`), csv_bytes: Buffer.byteLength(csvText),
    files: files.size, bytes: sizes.reduce((a, b) => a + b[1], 0), largest: { name: big[0], bytes: big[1] }, n_chunks: index.n_chunks, proofs_checked: idx.length,
    aliases: lookup && lookup.aliasStats, ms: 0 };
  if (compare) { const o = await v2FromPacket(sdk, compare, doc.fips, epoch); summary.compare = { against: path.basename(compare), ...diffV2(o.tree, tree) }; }
  summary.ms = Date.now() - t0;
  return summary;
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
    if (!a.csv || !a.out) throw new SetupError("build_v2 needs --csv and --out");
    const s = await buildV2({ csvPath: a.csv, rootPath: a.root, outDir: a.out, epoch: a.epoch ? Number(a.epoch) : undefined, rpc: a.rpc ?? "devnet", offline: !!a.offline,
      noidFile: a.noid, aliasFiles: a.aliases ? a.aliases.split(":") : [], chunk: a.chunk ? Number(a.chunk) : undefined, sample: a.sample === "all" ? 0 : a.sample ? Number(a.sample) : 256, compare: a.compare });
    log(JSON.stringify(s));
    return 0;
  } catch (e) {
    if (e instanceof VerifyError) { log(`BUILD REFUSED: ${e.message}`); return 1; }
    log(`ERROR: ${e.message}`); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
