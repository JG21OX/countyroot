// Devnet-only, one-time migration of existing CountyRoot accounts to the v2 layout (docs/provenance.md).
// Mainnet never runs this: the mainnet build rejects migrate_root/init_head/mark_superseded (DevnetOnly).
//
//   1. node scripts/migrate_v2.mjs manifests --batch <labels.txt|all> --dir <v2 dir> --out <manifest dir>
//        Writes <label>.e<N>.manifest.json (canonical bytes) for each county's latest epoch. Offline.
//   2. node scripts/migrate_v2.mjs run --manifests <manifest dir> [--state migrate_state.jsonl] [--send]
//        options: --keypair <path> (default $COUNTYROOT_ATTESTOR_KEYPAIR, else ~/.config/solana/id.json)
//                 --cluster devnet|localnet|<url> (default devnet; mainnet is refused)  --dry-run (default)
//
// Per county, ONE transaction holding whatever is still missing, in this order:
//   migrate_root(latest)  ->  init_head(fips, latest)  ->  mark_superseded(older ACTIVE epochs, by latest)
// Idempotent: a re-run reads the chain and only adds the missing steps; a fully migrated county is skipped.
// Refusals (stop the batch): manifest not canonical / bad keys / PII guard; the manifest's merkle_root or
// n_parcels differ from the on-chain account; an epoch above the manifest's exists; the latest root is not
// ACTIVE (a county whose newest epoch is retracted is reported and skipped: it has no active root, per D5);
// the program is paused; the signer is not Config.attestor.
// The manifest carries only county-level metadata. No parcel rows, owner names or site addresses, and nothing
// is hashed from them. Secret key bytes are never printed.
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { pathToFileURL } from "url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadSdk, VerifyError, SetupError } from "./verify.mjs";
import { rpcUrl, retryingFetch, resolveBatch } from "./post_v2.mjs";

const expand = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);
export const V1_LEN = 99, V2_LEN = 256, HEAD_LEN = 48, PROBE_AHEAD = 3;
const sha256 = (b) => createHash("sha256").update(b).digest();

// ---------------------------------------------------------------- manifest + PII guard
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const STREET = /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.' -]{2,40}\s(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|hwy|way|pl|place|cir|pkwy|ter|trl)\b\.?/i;
const PHONE = /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const HEX64 = /^[0-9a-f]{64}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Throws VerifyError if a manifest could carry personal data or is malformed. */
export function piiGuard(sdk, m) {
  const extra = Object.keys(m).filter((k) => !sdk.MANIFEST_KEYS.includes(k));
  if (extra.length) throw new VerifyError(`manifest has keys outside the allow-list: ${extra.join(", ")}`);
  const missing = sdk.MANIFEST_KEYS.filter((k) => !(k in m));
  if (missing.length) throw new VerifyError(`manifest is missing keys: ${missing.join(", ")}`);
  const walk = (v, where) => {
    if (typeof v === "string") {
      for (const [re, what] of [[EMAIL, "an email address"], [STREET, "a street address"], [PHONE, "a phone number"], [SSN, "an SSN-like number"]])
        if (re.test(v) && !(where === "source_url" && what !== "an email address" && /^https:\/\//.test(v) && !STREET.test(decodeURIComponent(v).replace(/[/?&=+_]/g, " "))))
          throw new VerifyError(`manifest ${where} looks like it contains ${what}`);
      if (v.length > 300) throw new VerifyError(`manifest ${where} is longer than 300 characters`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === "object") { if (where !== "pii_scan") throw new VerifyError(`manifest ${where} must not be an object`); for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`); }
  };
  for (const [k, v] of Object.entries(m)) walk(v, k);
  if (!/^(?:[A-Za-z .'-]{2,60}, [A-Z]{2}|[A-Za-z0-9._-]{2,60})$/.test(m.county_label ?? "")) throw new VerifyError(`county_label "${m.county_label}" is not "<Name> County, ST" or a label`);
  for (const k of ["schema_sha256", "packet_sha256", "merkle_root"]) if (!HEX64.test(m[k] ?? "")) throw new VerifyError(`${k} is not 64 hex characters`);
  if (m.source_sha256 !== null && !HEX64.test(m.source_sha256)) throw new VerifyError("source_sha256 must be 64 hex or null");
  if (!ISO.test(m.fetched_at ?? "")) throw new VerifyError(`fips ${m.fips}: fetched_at must be YYYY-MM-DDTHH:MM:SSZ (the program requires it; give it in --meta for migrated roots)`);
  if (m.data_as_of !== null && Date.parse(m.data_as_of) > Date.parse(m.fetched_at)) throw new VerifyError(`fips ${m.fips}: data_as_of is after fetched_at`);
  if (m.data_as_of !== null && !ISO.test(m.data_as_of)) throw new VerifyError("data_as_of must be YYYY-MM-DDTHH:MM:SSZ or null");
  if (!Number.isInteger(m.fips) || !Number.isInteger(m.epoch) || m.epoch < 1) throw new VerifyError("fips/epoch must be integers");
  if (![1, 2].includes(m.leaf_version)) throw new VerifyError("leaf_version must be 1 or 2");
}

/** Manifest for a migrated root, from its root.json and the packet CSV beside it. source_sha256 is null (D3). */
//  meta (optional, --meta <file.json>): { "<label>": { county_label, source_url, source_query, source_format, fetched_at,
//  data_as_of, source_record_count } }. Unknown fields stay null: nothing is invented for a migrated root.
export function buildManifest(sdk, rootPath, { builderCommit = null, meta = {} } = {}) {
  const raw = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  const doc = { ...raw, ...(meta[raw.label] ?? {}) };
  const csv = rootPath.replace(/\.root\.json$/, ".csv");
  if (!fs.existsSync(csv)) throw new VerifyError(`${path.basename(rootPath)}: packet CSV not found at ${csv}`);
  const iso = (s) => (s ? new Date(s).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
  const m = {
    county_label: doc.county_label ?? doc.label ?? null, fips: doc.fips, epoch: doc.epoch,
    source_url: doc.source_url ?? doc.source?.url ?? null, source_query: doc.source_query ?? doc.source?.query ?? null,
    source_format: doc.source_format ?? doc.source?.format ?? null,
    fetched_at: iso(doc.fetched_at ?? doc.source?.fetched_at), source_sha256: null,
    source_record_count: doc.source_record_count ?? null, data_as_of: iso(doc.data_as_of ?? doc.source?.data_as_of),
    builder_commit: builderCommit ?? doc.builder_commit ?? null, recipe: doc.recipe ?? `leaf-v${doc.leaf_version}`,
    leaf_version: doc.leaf_version, schema_sha256: doc.schema_sha256, packet_sha256: sha256(fs.readFileSync(csv)).toString("hex"),
    pii_scan: doc.pii_scan ?? { result: "pass", tool: "scripts/verify.mjs" }, n_parcels: Number(doc.n_parcels), merkle_root: doc.merkle_root,
    supersedes_epoch: doc.supersedes_epoch ?? null, reason: "migrated",
  };
  piiGuard(sdk, m);
  return { label: doc.label, bytes: sdk.canonicalManifest(m), manifest: m };
}

// ---------------------------------------------------------------- instructions
const keys = (...k) => k.map(([pubkey, w, s]) => ({ pubkey, isWritable: !!w, isSigner: !!s }));
export function migrateRootIx(sdk, { fips, epoch, manifestSha, sourceSha, packetSha, dataAsOf, fetchedAt, leafVersion, attestor }) {
  const d = Buffer.alloc(8 + 96 + 8 + 8 + 1);
  sdk.discriminator("global:migrate_root").copy(d, 0);
  manifestSha.copy(d, 8); sourceSha.copy(d, 40); packetSha.copy(d, 72);
  d.writeBigInt64LE(BigInt(dataAsOf), 104); d.writeBigInt64LE(BigInt(fetchedAt), 112); d.writeUInt8(leafVersion, 120);
  return new TransactionInstruction({ programId: sdk.PROGRAM_ID, data: d, keys: keys([sdk.configPda()], [sdk.countyRootPda(fips, epoch), 1], [attestor, 1, 1], [SystemProgram.programId]) });
}
export function initHeadIx(sdk, { fips, epoch, attestor }) {
  const d = Buffer.alloc(16); sdk.discriminator("global:init_head").copy(d, 0); d.writeUInt32LE(fips, 8); d.writeUInt32LE(epoch, 12);
  return new TransactionInstruction({ programId: sdk.PROGRAM_ID, data: d, keys: keys([sdk.configPda()], [sdk.countyHeadPda(fips), 1], [sdk.countyRootPda(fips, epoch)], [attestor, 1, 1], [SystemProgram.programId]) });
}
export function markSupersededIx(sdk, { fips, epoch, by, attestor }) {
  const d = Buffer.alloc(12); sdk.discriminator("global:mark_superseded").copy(d, 0); d.writeUInt32LE(by, 8);
  return new TransactionInstruction({ programId: sdk.PROGRAM_ID, data: d, keys: keys([sdk.configPda()], [sdk.countyRootPda(fips, epoch), 1], [sdk.countyHeadPda(fips)], [attestor, 0, 1]) });
}

// ---------------------------------------------------------------- planning (pure reads)
/** Read the county's accounts and return the steps still missing. Throws VerifyError on any inconsistency. */
export async function planCounty(sdk, conn, bytes, attestor) {
  const m = JSON.parse(bytes.toString("utf8"));
  if (!sdk.canonicalManifest(m).equals(bytes)) throw new VerifyError(`fips ${m.fips} e${m.epoch}: manifest file is not canonical`);
  piiGuard(sdk, m);
  const { fips, epoch } = m;
  const get = async (k) => { const i = await conn.getAccountInfo(k, "confirmed"); if (i && !i.owner.equals(sdk.PROGRAM_ID)) throw new VerifyError(`${k.toBase58()} is not owned by CountyRoot`); return i; };
  for (let e = epoch + 1; e <= epoch + PROBE_AHEAD; e++) if (await get(sdk.countyRootPda(fips, e))) throw new VerifyError(`fips ${fips}: epoch ${e} exists above the manifest's epoch ${epoch}`);
  const li = await get(sdk.countyRootPda(fips, epoch));
  if (!li) throw new VerifyError(`fips ${fips}: epoch ${epoch} is not on-chain`);
  const latest = sdk.decodeCountyRoot(li.data);
  const base = { fips, epoch, label: m.county_label, manifestSha: sdk.manifestSha256(bytes) };
  if (latest.merkleRoot.toString("hex") !== m.merkle_root || latest.nParcels !== BigInt(m.n_parcels) || latest.schema.toString("hex") !== m.schema_sha256)
    throw new VerifyError(`fips ${fips} e${epoch}: manifest root/count/schema differ from the on-chain account`);
  if (latest.status !== sdk.STATUS_ACTIVE) return { ...base, steps: [], skip: `latest epoch ${epoch} is ${sdk.STATUS_NAMES[latest.status] ?? latest.status}; left with no active root` };
  const steps = [], ixs = [];
  if (li.data.length < V2_LEN) {
    steps.push({ op: "migrate_root", epoch, grow: V2_LEN - li.data.length });
    ixs.push(migrateRootIx(sdk, { fips, epoch, manifestSha: base.manifestSha, sourceSha: Buffer.alloc(32), packetSha: Buffer.from(m.packet_sha256, "hex"),
      dataAsOf: sdk.isoToUnix(m.data_as_of), fetchedAt: sdk.isoToUnix(m.fetched_at), leafVersion: m.leaf_version, attestor }));
  } else if (!latest.provenance.manifestSha256.equals(base.manifestSha)) throw new VerifyError(`fips ${fips} e${epoch}: already migrated with a different manifest`);
  const hi = await get(sdk.countyHeadPda(fips));
  if (!hi) { steps.push({ op: "init_head", epoch }); ixs.push(initHeadIx(sdk, { fips, epoch, attestor })); }
  else { const h = sdk.decodeCountyHead(hi.data); if (h.latestEpoch !== epoch) throw new VerifyError(`fips ${fips}: head says latest ${h.latestEpoch}, manifest says ${epoch}`); }
  for (let e = 1; e < epoch; e++) {
    const oi = await get(sdk.countyRootPda(fips, e));
    if (!oi) continue;                                       // closed epochs leave gaps
    if (sdk.decodeCountyRoot(oi.data).status === sdk.STATUS_ACTIVE) { steps.push({ op: "mark_superseded", epoch: e, by: epoch }); ixs.push(markSupersededIx(sdk, { fips, epoch: e, by: epoch, attestor })); }
  }
  return { ...base, steps, ixs };
}

export async function costOf(conn, plans) {
  const per = async (n) => conn.getMinimumBalanceForRentExemption(n);
  const r0 = await per(V1_LEN), r2 = await per(V2_LEN), rh = await per(HEAD_LEN);
  let lamports = 0;
  for (const p of plans) for (const s of p.steps) {
    if (s.op === "migrate_root") lamports += r2 - (s.grow === V2_LEN - V1_LEN ? r0 : await per(V2_LEN - s.grow));
    if (s.op === "init_head") lamports += rh;
  }
  lamports += plans.filter((p) => p.steps.length).length * 5000;
  return lamports;
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const a = { cmd: argv[0], cluster: "devnet", send: false };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--send") a.send = true; else if (k === "--dry-run") a.dry = true;
    else if (["--batch", "--dir", "--out", "--manifests", "--state", "--keypair", "--cluster", "--attestor", "--builder-commit", "--max", "--meta"].includes(k)) {
      if (i + 1 >= argv.length) throw new SetupError(`${k} needs a value`); a[k.slice(2).replace("-c", "C")] = argv[++i];
    } else throw new SetupError(`unknown argument ${k}`);
  }
  if (a.dry) a.send = false;
  if (!["manifests", "run"].includes(a.cmd)) throw new SetupError("usage: migrate_v2.mjs manifests|run ... (see the header)");
  if (/mainnet/.test(a.cluster) || /api\.mainnet/.test(a.cluster)) throw new SetupError("migration is Devnet-only; mainnet is refused");
  return a;
}

export async function main(argv, { log = console.log, connection, signer: injected } = {}) {
  try {
    const a = parseArgs(argv);
    const sdk = await loadSdk();
    if (a.cmd === "manifests") {
      if (!a.batch || !a.dir || !a.out) throw new SetupError("manifests needs --batch, --dir and --out");
      fs.mkdirSync(expand(a.out), { recursive: true });
      for (const r of resolveBatch(expand(a.batch), expand(a.dir))) {
        const { label, bytes, manifest } = buildManifest(sdk, r, { builderCommit: a.builderCommit, meta: a.meta ? JSON.parse(fs.readFileSync(expand(a.meta), "utf8")) : {} });
        const f = path.join(expand(a.out), `${label}.e${manifest.epoch}.manifest.json`);
        fs.writeFileSync(f, bytes);
        log(`wrote ${f}  sha256 ${sdk.manifestSha256(bytes).toString("hex")}`);
      }
      return 0;
    }
    if (!a.manifests) throw new SetupError("run needs --manifests <dir>");
    const conn = connection ?? new Connection(rpcUrl(a.cluster), { commitment: "confirmed", fetch: retryingFetch });
    let kp = injected ?? null;
    const kpPath = expand(a.keypair ?? process.env.COUNTYROOT_ATTESTOR_KEYPAIR ?? "~/.config/solana/id.json");
    if (!kp && (a.send || (!a.attestor && fs.existsSync(kpPath)))) {
      if (!fs.existsSync(kpPath)) throw new SetupError(`attestor keypair not found: ${kpPath}`);
      kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
    }
    const signer = kp?.publicKey ?? (a.attestor ? new PublicKey(a.attestor) : (await sdk.fetchConfig(conn, "confirmed"))?.attestor);
    if (!signer) throw new SetupError("no signer: give --keypair or --attestor");
    const cfg = await sdk.fetchConfig(conn, "confirmed");
    if (!cfg) throw new VerifyError("Config account not found on this cluster");
    if (cfg.paused) throw new VerifyError("the program is paused (migration instructions refuse while paused; unpause first)");
    if (!cfg.attestor.equals(signer)) throw new VerifyError(`signing key ${signer.toBase58()} is not Config.attestor ${cfg.attestor.toBase58()}`);
    log(`${a.send ? "SEND" : "DRY RUN"}  cluster ${a.cluster}  attestor ${signer.toBase58()}${kp ? "" : " (public key only)"}`);

    const files = fs.readdirSync(expand(a.manifests)).filter((f) => f.endsWith(".manifest.json")).sort();
    const plans = [];
    for (const f of files) {
      const p = await planCounty(sdk, conn, fs.readFileSync(path.join(expand(a.manifests), f)), signer);
      log(p.skip ? `skip ${f}: ${p.skip}` : p.steps.length ? `todo ${f}: ${p.steps.map((s) => s.op + (s.op === "mark_superseded" ? `(e${s.epoch})` : "")).join(" + ")}` : `done ${f}: already migrated`);
      plans.push(p);
      if (a.max && plans.filter((x) => x.steps.length).length >= Number(a.max)) break;
    }
    const todo = plans.filter((p) => p.steps.length);
    const need = await costOf(conn, todo), bal = await conn.getBalance(signer, "confirmed");
    log(`counties to migrate: ${todo.length}, done: ${plans.length - todo.length - plans.filter((p) => p.skip).length}, skipped: ${plans.filter((p) => p.skip).length}. Needs ~${(need / LAMPORTS_PER_SOL).toFixed(6)} SOL; attestor balance ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    if (bal < need) { const msg = `attestor balance is short by ${((need - bal) / LAMPORTS_PER_SOL).toFixed(6)} SOL`; if (a.send) throw new VerifyError(msg); log(`WARNING: ${msg}`); }
    let n = 0;
    for (const p of todo) {
      const tx = new Transaction().add(...p.ixs); tx.feePayer = signer;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"); tx.recentBlockhash = blockhash;
      if (!a.send) {
        const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
        if (sim.value.err) throw new VerifyError(`fips ${p.fips}: simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
        log(`simulated fips ${p.fips}: OK (${sim.value.unitsConsumed ?? "?"} CU)`); continue;
      }
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
      const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (c.value.err) throw new VerifyError(`fips ${p.fips}: transaction ${sig} failed: ${JSON.stringify(c.value.err)}`);
      const again = await planCounty(sdk, conn, fs.readFileSync(path.join(expand(a.manifests), files.find((f) => f.includes(`.e${p.epoch}.`) && JSON.parse(fs.readFileSync(path.join(expand(a.manifests), f))).fips === p.fips))), signer);
      if (a.state) fs.appendFileSync(expand(a.state), JSON.stringify({ status: again.steps.length ? "incomplete" : "migrated", fips: p.fips, epoch: p.epoch, signature: sig, steps: p.steps.map((s) => s.op) }) + "\n");
      log(`migrated fips ${p.fips}: ${sig}`);
      if (again.steps.length) throw new VerifyError(`fips ${p.fips}: read-back still shows missing steps`);
      n++;
    }
    log(a.send ? `done: migrated ${n}` : `dry run complete: ${todo.length} would be migrated. Add --send to migrate.`);
    return 0;
  } catch (e) {
    if (e instanceof VerifyError) { log(`REFUSED: ${e.message}`); return 1; }
    log(`ERROR: ${e.message}`); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
