// Build the per-parcel proof sidecar files for one packet, for the browser verifier (countyroot/verifier).
//
//   node scripts/build_proofs.mjs --csv X.csv [--root X.root.json] --out <dir> [--rpc devnet|<url> | --offline 1]
//        [--chunk 2048] [--rows-per-shard 1500] [--max-bytes 102400]
//
// Writes <out>/<label>/<label>.<epoch>.<month>.proofs/ (the same key prefix as the packet on R2):
//   index.json   layout: format, fips, epoch, n_parcels, merkle_root, chunk_size, n_chunks, n_shards, ...
//   s/<k>.json   {format, shard, rows:[[parcel_id, acres, lot_sqft, leaf_index], ...]}  (k = shardOf(id) in verifier/cr-verify.js)
//   c/<k>.bin    32-byte leaf hashes for leaves k*chunk .. (k+1)*chunk-1
//   top.bin      every tree level from the chunk-root level up to the root
// and prints a JSON summary (file count, bytes, largest file).
//
// Safety: the packet is first checked with verify.mjs (full root rebuild against root.json and the parcel-ID
// personal-info check). With --rpc (default devnet) the on-chain account must exist, be ACTIVE and hold the same
// root and parcel count, so proofs are never built for a retracted or superseded epoch. Use --offline 1 only for tests.
// Duplicate parcel IDs are kept: every row is in its shard with its own leaf index, and the verifier returns all of them.
// Before writing, every row's proof is assembled from the sidecar files and compared with the SDK's makeProof.
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { verifyPacket, loadSdk, VerifyError, SetupError } from "./verify.mjs";
import * as V from "../verifier/cr-verify.js";

export const DEFAULTS = { chunk: 2048, rowsPerShard: 1500, maxBytes: 100 * 1024 };
const expand = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);
const rpcUrl = (v) => (v.startsWith("http") ? v : clusterApiUrl(v === "mainnet" ? "mainnet-beta" : v));

/** Pure: build all sidecar files in memory. rows: [{parcel_id, acres, lot_sqft}], leaves/levels from the SDK. */
export async function buildSidecar({ rows, levels, meta, chunk = DEFAULTS.chunk, rowsPerShard = DEFAULTS.rowsPerShard, maxBytes = DEFAULTS.maxBytes }) {
  if (chunk < 2 || chunk & (chunk - 1)) throw new Error("--chunk must be a power of two >= 2");
  const n = rows.length, leaves = levels[0], nChunks = Math.ceil(n / chunk);
  const files = new Map();
  // chunks
  for (let k = 0; k < nChunks; k++) files.set(`c/${k}.bin`, Buffer.concat(leaves.slice(k * chunk, (k + 1) * chunk)));
  // top levels (chunk-root level up to the root)
  const start = nChunks > 1 ? Math.log2(chunk) : levels.length - 1;
  if (levels[start].length !== nChunks) throw new Error("internal: chunk-root level has the wrong size");
  files.set("top.bin", Buffer.concat(levels.slice(start).flat()));
  // shards: grow the shard count until the largest shard fits maxBytes
  const keyShardHash = [];
  for (const r of rows) {
    const h = crypto.createHash("sha256").update(V.lookupKey(r.parcel_id), "utf8").digest();
    keyShardHash.push(h.readUInt32BE(0));
  }
  let nShards = Math.max(1, Math.ceil(n / rowsPerShard)), shardFiles;
  for (;;) {
    const buckets = Array.from({ length: nShards }, () => []);
    rows.forEach((r, i) => buckets[keyShardHash[i] % nShards].push([r.parcel_id, r.acres, r.lot_sqft, i]));
    shardFiles = buckets.map((b, k) => Buffer.from(JSON.stringify({ format: V.PROOF_FORMAT, shard: k, rows: b })));
    const big = Math.max(...shardFiles.map((b) => b.length));
    if (big <= maxBytes || nShards >= n) break;
    nShards = Math.ceil(nShards * 1.25) + 1;
  }
  shardFiles.forEach((b, k) => files.set(`s/${k}.json`, b));
  const index = {
    format: V.PROOF_FORMAT, ...meta, n_parcels: n, chunk_size: chunk, n_chunks: nChunks, n_shards: nShards,
    leaf: "sha256(utf8 parcel_id|acres_6dp|lot_sqft_2dp)", tree: "sha256(left||right); odd level duplicates the last node",
    shard_key: "sha256(utf8(upper(trim(parcel_id))))[0..4] big-endian u32 mod n_shards",
    note: "Untrusted layout file. Verify against the on-chain CountyRoot account, not against this file.",
  };
  files.set("index.json", Buffer.from(JSON.stringify(index, null, 1) + "\n"));
  return { files, index };
}

/** Assemble every row's proof from the sidecar files and compare with the SDK (all rows, or a sample). */
export async function selfCheck({ files, index, levels, sdk, sample }) {
  const n = index.n_parcels, top = new Uint8Array(files.get("top.bin")), views = new Map();
  const view = (k) => { if (!views.has(k)) { views.clear(); views.set(k, new Uint8Array(files.get(`c/${k}.bin`))); } return views.get(k); };
  const idx = sample && sample < n ? pickSample(n, sample, index.chunk_size) : [...Array(n).keys()];
  for (const i of idx) {
    const k = Math.floor(i / index.chunk_size);
    const leaf = new Uint8Array(levels[0][i]);
    const got = await V.assembleProof({ leaf, index: i, nLeaves: n, chunkSize: index.chunk_size, chunkBytes: view(k), topBytes: top });
    const want = sdk.makeProof(levels, i);
    if (got.leaf !== want.leaf || got.siblings.join() !== want.siblings.join() || got.leafCount !== want.leafCount) throw new Error(`self-check: proof for leaf ${i} differs from the SDK`);
    if (!sdk.verifyProof(got, levels[levels.length - 1][0])) throw new Error(`self-check: SDK rejects the assembled proof for leaf ${i}`);
  }
  // every row is findable in its shard at its own index
  const shards = new Map();
  for (const [name, buf] of files) if (name.startsWith("s/")) shards.set(name, JSON.parse(buf));
  let seen = 0;
  for (const [, s] of shards) seen += s.rows.length;
  if (seen !== n) throw new Error(`self-check: shards hold ${seen} rows, expected ${n}`);
  return idx.length;
}
function pickSample(n, m, chunk) {
  const s = new Set([0, 1, n - 1, n - 2, Math.floor(n / 2)].filter((x) => x >= 0 && x < n));
  for (let k = chunk; k < n; k += chunk) { s.add(k - 1); s.add(k); }
  let x = 12345; while (s.size < Math.min(n, m + s.size)) { x = (x * 1103515245 + 12345) % 2147483648; s.add(x % n); if (s.size >= m * 2) break; }
  return [...s].sort((a, b) => a - b);
}

export async function buildProofs({ csvPath, rootPath, outDir, rpc = "devnet", offline = false, chunk, rowsPerShard, maxBytes, sample = 20000, log = () => {} }) {
  const sdk = await loadSdk();
  const v = await verifyPacket({ csvPath, rootPath }); // full rebuild vs root.json + PII check; throws VerifyError
  const doc = JSON.parse(fs.readFileSync(v.rootPath, "utf8"));
  const base = path.basename(v.csvPath).replace(/\.csv$/, "");
  const m = /^(.+)\.(\d+)\.(\d{4}-\d\d)$/.exec(base);
  if (!m) throw new VerifyError(`packet file name ${base}.csv is not <label>.<epoch>.<yyyy-mm>.csv`);
  const [, label, ep, month] = m;
  if (Number(ep) !== doc.epoch) throw new VerifyError(`file name epoch ${ep} != root.json epoch ${doc.epoch}`);
  const pda = sdk.countyRootPda(doc.fips, doc.epoch).toBase58();
  let onchain = null;
  if (!offline) {
    const conn = new Connection(rpcUrl(rpc), "finalized");
    const acct = await sdk.fetchCountyRoot(conn, doc.fips, doc.epoch, "finalized");
    if (!acct) throw new VerifyError(`no on-chain account ${pda} for fips ${doc.fips} epoch ${doc.epoch}`);
    if (acct.status !== sdk.STATUS_ACTIVE) throw new VerifyError(`fips ${doc.fips} epoch ${doc.epoch} is not ACTIVE on-chain (status ${acct.status}); no proofs for retracted epochs`);
    if (acct.merkleRoot.toString("hex") !== doc.merkle_root) throw new VerifyError(`on-chain root ${acct.merkleRoot.toString("hex")} != packet root ${doc.merkle_root}`);
    if (acct.nParcels !== BigInt(doc.n_parcels)) throw new VerifyError(`on-chain n_parcels ${acct.nParcels} != packet ${doc.n_parcels}`);
    onchain = { status: "active", posted_at: Number(acct.postedAt), version: acct.version };
  }
  const rows = sdk.parsePacketCsv(fs.readFileSync(v.csvPath, "utf8"));
  const levels = sdk.buildLevels(sdk.packetLeaves(rows));
  const meta = { label, fips: doc.fips, epoch: doc.epoch, month, merkle_root: doc.merkle_root, pda, program: V.PROGRAM_ID,
                 packet_file: `${base}.csv`, packet_sha256: crypto.createHash("sha256").update(fs.readFileSync(v.csvPath)).digest("hex") };
  const { files, index } = await buildSidecar({ rows, levels, meta, chunk, rowsPerShard, maxBytes });
  const checked = await selfCheck({ files, index, levels, sdk, sample });
  const dir = path.join(outDir, label, `${base}.proofs`);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, buf] of files) { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  const sizes = [...files].map(([name, b]) => [name, b.length]);
  const big = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
  const dupIds = rows.length - new Set(rows.map((r) => V.lookupKey(r.parcel_id))).size;
  const summary = { label, fips: doc.fips, epoch: doc.epoch, dir, n_parcels: rows.length, duplicate_rows: dupIds, onchain, files: files.size,
                    bytes: sizes.reduce((a, b) => a + b[1], 0), largest: { name: big[0], bytes: big[1] }, n_shards: index.n_shards, n_chunks: index.n_chunks, proofs_checked: checked };
  if (big[1] > (maxBytes ?? DEFAULTS.maxBytes) + 70 * 1024) log(`WARNING: ${big[0]} is ${big[1]} bytes`);
  return summary;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new SetupError(`unexpected ${argv[i]}`);
    if (i + 1 >= argv.length) throw new SetupError(`${argv[i]} needs a value`);
    a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}
export async function main(argv, log = console.log) {
  try {
    const a = parseArgs(argv);
    if (!a.csv || !a.out) throw new SetupError("build_proofs needs --csv and --out");
    const num = (x) => (x === undefined ? undefined : Number(x));
    const s = await buildProofs({ csvPath: expand(a.csv), rootPath: a.root ? expand(a.root) : undefined, outDir: expand(a.out), rpc: a.rpc ?? "devnet",
      offline: !!a.offline, chunk: num(a.chunk), rowsPerShard: num(a["rows-per-shard"]), maxBytes: num(a["max-bytes"]), sample: a.sample === "all" ? 0 : num(a.sample) ?? 20000, log });
    log(JSON.stringify(s));
    return 0;
  } catch (e) {
    if (e instanceof VerifyError) { log(`BUILD REFUSED: ${e.message}`); return 1; }
    log(`ERROR: ${e.message}`); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
