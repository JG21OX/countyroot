// Pre-post Merkle check for a CountyRoot packet. Uses the SDK's leaf/tree code (countyroot/sdk).
//
//   node scripts/verify.mjs --csv X.csv [--root X.root.json]            (root.json defaults to X.root.json)
//   node scripts/verify.mjs --label Travis.TX --epoch 2 [--dir <packets dir>]
//   options: --fips N --epoch N --expect-root <hex> --expect-n N   (also compare with what will be posted)
//            --allow-pii 1   (skip the parcel-ID personal-info check; see scripts/pii.mjs)
//            --rpc devnet|<url>   (refuse if this fips/epoch was ever closed or is retracted on-chain)
// Exit code 0 = OK, 1 = mismatch/refused (reason printed), 2 = usage or setup error.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { scanRows, loadAllowlist } from "./pii.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.join(here, "../sdk/dist/src/index.js");
let sdk;
export async function loadSdk() {
  if (sdk) return sdk;
  if (!fs.existsSync(SDK)) throw new SetupError("SDK not built. Run: (cd sdk && npm ci && npm run build)");
  sdk = await import(pathToFileURL(SDK).href);
  return sdk;
}

export class VerifyError extends Error {}
export class SetupError extends Error {}
const expand = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);

export const CLOSED_EPOCHS_FILE = path.join(here, "closed-epochs.json");
export function loadClosedEpochs(file = CLOSED_EPOCHS_FILE) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).closed ?? [];
}

export function packetDirs() {
  return (process.env.COUNTYROOT_PACKETS_DIR || "~/Downloads").split(":").map(expand);
}

/** Find root.json files (depth <= 3) under the packet dirs. */
export function findRootJsons(dirs = packetDirs(), maxDepth = 3) {
  const out = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".root.json")) out.push(p);
    }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

/** Locate the packet for fips/epoch (preferring one whose merkle_root matches). */
export function locatePacket({ fips, epoch, merkleRoot, label }, dirs = packetDirs()) {
  const hits = [];
  for (const f of findRootJsons(dirs)) {
    let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    if (label && d.label !== label) continue;
    if (fips !== undefined && d.fips !== fips) continue;
    if (epoch !== undefined && d.epoch !== epoch) continue;
    hits.push({ rootPath: f, doc: d });
  }
  const exact = merkleRoot ? hits.filter((h) => h.doc.merkle_root === merkleRoot) : hits;
  const pick = exact.length ? exact : hits;
  if (!pick.length) throw new VerifyError(`no local packet for ${label ?? ""} fips ${fips} epoch ${epoch} under ${dirs.join(", ")} (set COUNTYROOT_PACKETS_DIR)`);
  if (pick.length > 1 && !exact.length) throw new VerifyError(`several packets match fips ${fips} epoch ${epoch}: ${pick.map((h) => h.rootPath).join(", ")}`);
  return pick[0].rootPath;
}

/** Check the closed-epoch policy. With a connection: refuse if the PDA has history but no account (closed), or is retracted. */
export async function checkEpochPolicy({ fips, epoch, op = "post" }, { connection, closedEpochs = loadClosedEpochs() } = {}) {
  if (closedEpochs.some((c) => c.fips === fips && c.epoch === epoch))
    throw new VerifyError(`fips ${fips} epoch ${epoch} is in closed-epochs.json; corrections must use a new epoch`);
  if (!connection) return { rpc: false };
  const { countyRootPda, decodeCountyRoot, PROGRAM_ID, STATUS_RETRACTED } = await loadSdk();
  const pda = countyRootPda(fips, epoch);
  const info = await connection.getAccountInfo(pda, "confirmed");
  if (info && !info.owner.equals(PROGRAM_ID)) throw new VerifyError(`${pda.toBase58()} is not owned by CountyRoot`);
  if (info) {
    const a = decodeCountyRoot(info.data);
    if (a.status === STATUS_RETRACTED) throw new VerifyError(`fips ${fips} epoch ${epoch} is RETRACTED on-chain; use a new epoch`);
    if (op === "post") throw new VerifyError(`fips ${fips} epoch ${epoch} is already posted (${pda.toBase58()}); use update or a new epoch`);
  } else {
    const sigs = await connection.getSignaturesForAddress(pda, { limit: 1 }, "confirmed");
    if (sigs.length) throw new VerifyError(`fips ${fips} epoch ${epoch} was CLOSED on-chain (account has history but no data); never reuse a closed epoch`);
    if (op === "update") throw new VerifyError(`fips ${fips} epoch ${epoch} does not exist on-chain`);
  }
  return { rpc: true };
}

/**
 * Verify a packet CSV against its root.json, and optionally against the values about to be posted.
 * Returns { ok: true, ... } or throws VerifyError with the reason.
 */
export async function verifyPacket({ csvPath, rootPath, expect = {}, pii = true, allowlist }) {
  const { parsePacketCsv, leafHash, buildLevels } = await loadSdk();
  rootPath ??= csvPath.replace(/\.csv$/, ".root.json");
  if (!fs.existsSync(rootPath)) throw new VerifyError(`root.json not found: ${rootPath}`);
  const doc = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  csvPath ??= path.join(path.dirname(rootPath), doc.packet_file ?? path.basename(rootPath).replace(/\.root\.json$/, ".csv"));
  if (!fs.existsSync(csvPath)) throw new VerifyError(`packet CSV not found: ${csvPath}`);
  for (const k of ["fips", "epoch", "n_parcels", "merkle_root"]) if (doc[k] === undefined) throw new VerifyError(`root.json missing ${k}`);
  if (doc.program && doc.program !== "7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg") throw new VerifyError(`root.json is for another program: ${doc.program}`);

  const text = fs.readFileSync(csvPath, "utf8");
  const S = await loadSdk();
  if (doc.leaf_version === 2 || S.isPacketCsvV2(text)) return verifyPacketV2({ S, doc, text, csvPath, rootPath, expect, pii, allowlist });
  if (doc.schema_sha256 && doc.schema_sha256 !== S.SCHEMA_V1.toString("hex")) throw new VerifyError(`root.json schema ${doc.schema_sha256} is not the v1 leaf schema`);
  const rows = parsePacketCsv(text);
  const leaves = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.parcel_id) throw new VerifyError(`row ${i + 2}: empty parcel_id`);
    let h;
    try { h = leafHash(r.parcel_id, r.acres, r.lot_sqft); } catch (e) { throw new VerifyError(`row ${i + 2} (${r.parcel_id}): ${e.message}`); }
    if (r.leaf !== undefined && r.leaf.toLowerCase() !== h.toString("hex"))
      throw new VerifyError(`row ${i + 2} (${r.parcel_id}): stored leaf ${r.leaf} != recomputed ${h.toString("hex")}`);
    leaves[i] = h;
  }
  if (pii) {
    const hits = scanRows(rows, allowlist ?? loadAllowlist());
    if (hits.length) {
      const shown = hits.slice(0, 10).map((h) => `row ${h.row} ${h.reason} "${h.masked}"`).join("; ");
      throw new VerifyError(`${hits.length} parcel ID(s) look like personal info (${shown}${hits.length > 10 ? "; ..." : ""}). Replace them in a new epoch, or add a reviewed place name to scripts/pii-allowlist.json`);
    }
  }
  if (rows.length !== Number(doc.n_parcels)) throw new VerifyError(`CSV has ${rows.length} rows but root.json n_parcels is ${doc.n_parcels}`);
  const levels = buildLevels(leaves);
  const root = levels[levels.length - 1][0].toString("hex");
  if (root !== doc.merkle_root) throw new VerifyError(`rebuilt root ${root} != root.json merkle_root ${doc.merkle_root}`);

  const cmp = (name, got, want) => { if (got !== undefined && String(got) !== String(want)) throw new VerifyError(`${name} to post (${got}) != packet ${name} (${want})`); };
  cmp("fips", expect.fips, doc.fips);
  cmp("epoch", expect.epoch, doc.epoch);
  cmp("n_parcels", expect.nParcels, doc.n_parcels);
  cmp("merkle_root", expect.merkleRoot, doc.merkle_root);
  return { ok: true, csvPath, rootPath, label: doc.label, fips: doc.fips, epoch: doc.epoch, nParcels: rows.length, root };
}

/** Leaf format v2 packet (docs/leaf-v2.md): strict CSV, leaf order, occ, stored leaves, root bound to fips/epoch/n. */
async function verifyPacketV2({ S, doc, text, csvPath, rootPath, expect, pii, allowlist }) {
  if (doc.leaf_version !== 2) throw new VerifyError("v2 packet CSV but root.json is not leaf_version 2");
  if (!S.isPacketCsvV2(text)) throw new VerifyError("root.json is leaf_version 2 but the CSV is not a v2 packet CSV");
  if (doc.schema_sha256 !== S.SCHEMA_V2.toString("hex")) throw new VerifyError(`root.json schema_sha256 ${doc.schema_sha256} is not the v2 schema ${S.SCHEMA_V2.toString("hex")}`);
  let t;
  try { t = S.treeFromCsvV2(Number(doc.fips), Number(doc.epoch), text); } catch (e) { throw new VerifyError(e.message); }
  if (pii) {
    const hits = scanRows(t.rows.map((r) => ({ parcel_id: r.id })), allowlist ?? loadAllowlist());
    if (hits.length) {
      const shown = hits.slice(0, 10).map((h) => `row ${h.row} ${h.reason} "${h.masked}"`).join("; ");
      throw new VerifyError(`${hits.length} parcel ID(s) look like personal info (${shown}${hits.length > 10 ? "; ..." : ""}). Replace them in a new epoch, or add a reviewed place name to scripts/pii-allowlist.json`);
    }
  }
  if (t.rows.length !== Number(doc.n_parcels)) throw new VerifyError(`CSV has ${t.rows.length} rows but root.json n_parcels is ${doc.n_parcels}`);
  const root = t.root.toString("hex");
  if (root !== doc.merkle_root) throw new VerifyError(`rebuilt v2 root ${root} != root.json merkle_root ${doc.merkle_root}`);
  const cmp = (name, got, want) => { if (got !== undefined && String(got) !== String(want)) throw new VerifyError(`${name} to post (${got}) != packet ${name} (${want})`); };
  cmp("fips", expect.fips, doc.fips); cmp("epoch", expect.epoch, doc.epoch); cmp("n_parcels", expect.nParcels, doc.n_parcels); cmp("merkle_root", expect.merkleRoot, doc.merkle_root);
  return { ok: true, csvPath, rootPath, label: doc.label, fips: doc.fips, epoch: doc.epoch, nParcels: t.rows.length, root, leafVersion: 2, schema: doc.schema_sha256, tree: t };
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
const rpcUrl = (v) => (v.startsWith("http") ? v : clusterApiUrl(v === "mainnet" ? "mainnet-beta" : v));

export async function main(argv, log = console.log) {
  try {
    const a = parseArgs(argv);
    const num = (v) => (v === undefined ? undefined : Number(v));
    let rootPath = a.root ? expand(a.root) : undefined, csvPath = a.csv ? expand(a.csv) : undefined;
    if (!csvPath && !rootPath) {
      if (!a.label && !a.fips) throw new SetupError("give --csv, --root, --label or --fips/--epoch");
      const dirs = a.dir ? [expand(a.dir)] : packetDirs();
      rootPath = locatePacket({ label: a.label, fips: num(a.fips), epoch: num(a.epoch), merkleRoot: a["expect-root"] }, dirs);
    }
    const r = await verifyPacket({ csvPath, rootPath, expect: { fips: num(a.fips), epoch: num(a.epoch), nParcels: a["expect-n"], merkleRoot: a["expect-root"] }, pii: !a["allow-pii"] });
    if (a.rpc) await checkEpochPolicy({ fips: r.fips, epoch: r.epoch, op: a.op ?? "post" }, { connection: new Connection(rpcUrl(a.rpc), "confirmed") });
    else await checkEpochPolicy({ fips: r.fips, epoch: r.epoch });
    log(`VERIFIED ${r.label ?? ""} fips ${r.fips} epoch ${r.epoch}: ${r.nParcels} parcels, root ${r.root}${a.rpc ? " (on-chain epoch policy checked)" : ""}`);
    return 0;
  } catch (e) {
    if (e instanceof VerifyError) { log(`VERIFY FAILED: ${e.message}`); return 1; }
    log(`ERROR: ${e.message}`); return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
