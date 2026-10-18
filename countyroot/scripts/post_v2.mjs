// Post leaf-format-v2 roots (docs/leaf-v2.md) to CountyRoot, from the v2 root.json files. Data-driven: one script
// for every county; the fips, epoch, count, root and schema all come from the root.json and are re-checked here.
//
//   node scripts/post_v2.mjs --root <dir>/<label>/<label>.<E>.<month>.root.json [--send]
//   node scripts/post_v2.mjs --batch <labels.txt | all> --dir <v2 dir> [--state post_v2_state.jsonl] [--max N] [--send]
//   options: --keypair <path> (default $COUNTYROOT_ATTESTOR_KEYPAIR, else ~/.config/solana/id.json)
//            --cluster devnet|<url> (default devnet)   --dry-run (the default; nothing is sent without --send)
//
// DRY RUN by default: every check below runs, each transaction is simulated, and the SOL estimate is printed.
// --send submits, one county per transaction, and reads each account back before moving on.
// Preflight, per county, before anything is sent:
//   1. the v2 packet CSV beside the root.json rebuilds the root (strict v2 reader) and passes the parcel-ID
//      personal-info check (scripts/verify.mjs), and the root.json schema is the v2 schema;
//   2. closed-epoch policy: not in closed-epochs.json, never closed on-chain, not retracted;
//   3. the epoch is not already on-chain. If it holds exactly this root/count/v2 schema it is skipped as already
//      posted (so a batch can be re-run); anything else there is refused;
//   4. the v1 epoch it supersedes is on-chain, ACTIVE, with the v1 root the packet was derived from;
//   5. Config is not paused and the signing key is Config.attestor;
//   6. the attestor balance covers rent (99-byte account) + fees for everything still to post.
// Batch: resumable. Posted counties are appended to --state; on a re-run they (and anything already on-chain
// with the same root) are skipped. A refused county stops the batch. Secret key bytes are never printed.
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { verifyPacket, checkEpochPolicy, loadClosedEpochs, loadSdk, VerifyError, SetupError } from "./verify.mjs";

export const ACCOUNT_LEN = 99;          // COUNTY_ROOT_V1_LEN: what post_root allocates
export const FEE_LAMPORTS = 5000;       // one signature per transaction
const expand = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);
export const rpcUrl = (v) => (v.startsWith("http") ? v : v === "localnet" ? "http://127.0.0.1:8899" : clusterApiUrl(v === "mainnet" ? "mainnet-beta" : v));

/** fetch with retries: public RPCs drop connections and rate-limit (429) during long batches. Sends are not retried
 *  blindly by web3.js on top of this; a retried sendTransaction re-submits the same signed bytes, which is idempotent. */
export async function retryingFetch(url, opts, { tries = 6, base = 500, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetchImpl(url, opts);
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(base * 2 ** i); continue; }
      return r;
    } catch (e) { if (i >= tries - 1) throw e; await sleep(base * 2 ** i); }
  }
}

/** post_root(fips u32, epoch u32, n_parcels u64, merkle_root [u8;32], schema [u8;32]); accounts config, county_root, attestor, system. */
export function postRootIx(sdk, { fips, epoch, nParcels, root, schema, attestor }) {
  const data = Buffer.alloc(8 + 4 + 4 + 8 + 32 + 32);
  sdk.discriminator("global:post_root").copy(data, 0);
  data.writeUInt32LE(fips, 8); data.writeUInt32LE(epoch, 12); data.writeBigUInt64LE(BigInt(nParcels), 16);
  Buffer.from(root).copy(data, 24); Buffer.from(schema).copy(data, 56);
  return new TransactionInstruction({ programId: sdk.PROGRAM_ID, data, keys: [
    { pubkey: sdk.configPda(), isSigner: false, isWritable: false },
    { pubkey: sdk.countyRootPda(fips, epoch), isSigner: false, isWritable: true },
    { pubkey: attestor, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } ] });
}

/** Checks 1-4 for one root.json. Returns { action: "post" | "skip", ... } or throws VerifyError. */
export async function preflightV2(sdk, conn, rootPath, { closedEpochs = loadClosedEpochs() } = {}) {
  const doc = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  if (doc.leaf_version !== 2) throw new VerifyError(`${path.basename(rootPath)} is not a leaf_version 2 root.json`);
  const schemaHex = sdk.SCHEMA_V2.toString("hex");
  if (doc.schema_sha256 !== schemaHex) throw new VerifyError(`${path.basename(rootPath)}: schema ${doc.schema_sha256} is not the v2 schema`);
  const v = await verifyPacket({ rootPath });           // strict v2 CSV rebuild + PII check (throws VerifyError)
  const want = { fips: doc.fips, epoch: doc.epoch, n: BigInt(doc.n_parcels), root: doc.merkle_root };
  const pda = sdk.countyRootPda(doc.fips, doc.epoch);
  const base = { label: doc.label, fips: doc.fips, epoch: doc.epoch, n_parcels: doc.n_parcels, merkle_root: doc.merkle_root, pda: pda.toBase58(), rootPath };
  const info = await conn.getAccountInfo(pda, "confirmed");
  if (info) {
    if (!info.owner.equals(sdk.PROGRAM_ID)) throw new VerifyError(`${pda.toBase58()} is not owned by CountyRoot`);
    const a = sdk.decodeCountyRoot(info.data);
    if (a.status === sdk.STATUS_ACTIVE && a.merkleRoot.toString("hex") === want.root && a.nParcels === want.n && Buffer.from(a.schema).toString("hex") === schemaHex)
      return { ...base, action: "skip", why: "already posted with this root" };
  }
  await checkEpochPolicy({ fips: doc.fips, epoch: doc.epoch, op: "post" }, { connection: conn, closedEpochs }); // closed / retracted / exists
  const prev = doc.supersedes_epoch ?? doc.derived_from?.v1_epoch;
  if (prev !== undefined) {
    const p = await sdk.fetchCountyRoot(conn, doc.fips, prev, "confirmed");
    if (!p) throw new VerifyError(`superseded epoch ${prev} is not on-chain`);
    if (p.status !== sdk.STATUS_ACTIVE) throw new VerifyError(`superseded epoch ${prev} is not ACTIVE on-chain`);
    if (doc.derived_from?.v1_root && p.merkleRoot.toString("hex") !== doc.derived_from.v1_root) throw new VerifyError(`on-chain epoch ${prev} root differs from the v1 root this packet was derived from`);
  }
  return { ...base, action: "post", verified: v.root === doc.merkle_root };
}

/** Check 5. */
export async function checkConfig(sdk, conn, signer) {
  const cfg = await sdk.fetchConfig(conn, "confirmed");
  if (!cfg) throw new VerifyError("Config account not found on this cluster");
  if (cfg.paused) throw new VerifyError("the program is paused");
  if (!cfg.attestor.equals(signer)) throw new VerifyError(`signing key ${signer.toBase58()} is not Config.attestor ${cfg.attestor.toBase58()}`);
  return cfg;
}

/** Check 6: lamports needed for `count` posts. */
export async function estimate(conn, count) {
  const rent = await conn.getMinimumBalanceForRentExemption(ACCOUNT_LEN);
  return { rent_per_account: rent, fee_per_tx: FEE_LAMPORTS, count, lamports: count * (rent + FEE_LAMPORTS), sol: (count * (rent + FEE_LAMPORTS)) / LAMPORTS_PER_SOL };
}

/** Resolve --batch: "all" = every <dir>/<label>/*.root.json with leaf_version 2; else a file of labels or root.json paths. */
export function resolveBatch(batch, dir) {
  const v2In = (label) => {
    const d = path.join(dir, label);
    const hits = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".root.json")).map((f) => path.join(d, f))
      .filter((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).leaf_version === 2; } catch { return false; } }) : [];
    if (hits.length !== 1) throw new SetupError(`${label}: expected one v2 root.json under ${d}, found ${hits.length}`);
    return hits[0];
  };
  if (batch === "all") return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort().map(v2In);
  return fs.readFileSync(batch, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
    .map((l) => (l.endsWith(".root.json") ? expand(l) : v2In(l)));
}

export function loadState(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  return new Map(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === "posted").map((r) => [`${r.fips}/${r.epoch}`, r]));
}

function parseArgs(argv) {
  const a = { cluster: "devnet", send: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--send") a.send = true;
    else if (k === "--dry-run") a.dry = true;
    else if (["--root", "--batch", "--dir", "--state", "--max", "--keypair", "--cluster", "--attestor"].includes(k)) {
      if (i + 1 >= argv.length) throw new SetupError(`${k} needs a value`);
      a[k.slice(2)] = argv[++i];
    } else throw new SetupError(`unknown argument ${k}`);
  }
  if (a.dry) a.send = false;
  if (!a.root && !a.batch) throw new SetupError("give --root <root.json> or --batch <labels.txt|all> --dir <v2 dir>");
  if (a.batch && !a.dir) throw new SetupError("--batch needs --dir");
  return a;
}

export async function main(argv, { log = console.log, connection, signer: injected } = {}) {
  try {
    const a = parseArgs(argv);
    const sdk = await loadSdk();
    const conn = connection ?? new Connection(rpcUrl(a.cluster), { commitment: "confirmed", fetch: retryingFetch });
    // signer: a keypair is needed to send; a dry run can use only the public key (--attestor, else Config.attestor)
    let kp = injected ?? null, signer;
    const kpPath = expand(a.keypair ?? process.env.COUNTYROOT_ATTESTOR_KEYPAIR ?? "~/.config/solana/id.json");
    if (!kp && (a.send || (!a.attestor && fs.existsSync(kpPath)))) {
      if (!fs.existsSync(kpPath)) throw new SetupError(`attestor keypair not found: ${kpPath}`);
      kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
    }
    if (kp) signer = kp.publicKey;
    else if (a.attestor) signer = new PublicKey(a.attestor);
    else signer = (await sdk.fetchConfig(conn, "confirmed"))?.attestor;
    if (!signer) throw new SetupError("no signer: give --keypair or --attestor");
    log(`${a.send ? "SEND" : "DRY RUN"}  cluster ${a.cluster}  attestor ${signer.toBase58()}${kp ? "" : " (public key only)"}`);
    await checkConfig(sdk, conn, signer);

    const roots = a.root ? [expand(a.root)] : resolveBatch(expand(a.batch), expand(a.dir));
    const state = loadState(a.state && expand(a.state));
    const plan = [];
    for (const r of roots) {
      const doc = JSON.parse(fs.readFileSync(r, "utf8"));
      if (state.has(`${doc.fips}/${doc.epoch}`)) { const s = state.get(`${doc.fips}/${doc.epoch}`); if (s.merkle_root !== doc.merkle_root) throw new VerifyError(`${doc.label}: state file has a different root for epoch ${doc.epoch}`); }
      const p = await preflightV2(sdk, conn, r);
      log(`${p.action === "skip" ? "skip" : "ok  "} ${p.label} fips ${p.fips} epoch ${p.epoch}: ${p.n_parcels} leaves, root ${p.merkle_root}${p.action === "skip" ? ` (${p.why})` : ""}`);
      plan.push(p);
      if (a.max && plan.filter((x) => x.action === "post").length >= Number(a.max)) break;
    }
    const todo = plan.filter((p) => p.action === "post");
    const est = await estimate(conn, todo.length), bal = await conn.getBalance(signer, "confirmed");
    log(`to post: ${todo.length}, already posted: ${plan.length - todo.length}. Needs ${est.sol.toFixed(6)} SOL (${est.rent_per_account} rent + ${est.fee_per_tx} fee lamports each); attestor balance ${(bal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    if (bal < est.lamports) {
      const msg = `attestor balance is short by ${((est.lamports - bal) / LAMPORTS_PER_SOL).toFixed(6)} SOL (send Devnet SOL to ${signer.toBase58()})`;
      if (a.send) throw new VerifyError(msg); else log(`WARNING: ${msg}`);
    }
    let posted = 0;
    for (const p of todo) {
      const doc = JSON.parse(fs.readFileSync(p.rootPath, "utf8"));
      const ix = postRootIx(sdk, { fips: doc.fips, epoch: doc.epoch, nParcels: doc.n_parcels, root: Buffer.from(doc.merkle_root, "hex"), schema: sdk.SCHEMA_V2, attestor: signer });
      const tx = new Transaction().add(ix); tx.feePayer = signer;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"); tx.recentBlockhash = blockhash;
      if (!a.send) {
        const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
        if (sim.value.err) throw new VerifyError(`${p.label}: simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
        log(`simulated ${p.label} epoch ${p.epoch}: OK (${sim.value.unitsConsumed ?? "?"} CU)`);
        continue;
      }
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
      const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (c.value.err) throw new VerifyError(`${p.label}: transaction ${sig} failed: ${JSON.stringify(c.value.err)}`);
      const back = await sdk.fetchCountyRoot(conn, doc.fips, doc.epoch, "confirmed");
      const good = back && back.status === sdk.STATUS_ACTIVE && back.merkleRoot.toString("hex") === doc.merkle_root && back.nParcels === BigInt(doc.n_parcels) && Buffer.from(back.schema).equals(sdk.SCHEMA_V2);
      const rec = { status: good ? "posted" : "posted-mismatch", label: p.label, fips: doc.fips, epoch: doc.epoch, merkle_root: doc.merkle_root, pda: p.pda, signature: sig, posted_at: back ? Number(back.postedAt) : null };
      if (a.state) fs.appendFileSync(expand(a.state), JSON.stringify(rec) + "\n");
      log(`posted ${p.label} epoch ${doc.epoch}: ${sig}`);
      if (!good) throw new VerifyError(`${p.label}: account read back does not match what was posted`);
      posted++;
    }
    log(a.send ? `done: posted ${posted}, skipped ${plan.length - todo.length}` : `dry run complete: ${todo.length} would be posted, ${plan.length - todo.length} skipped. Add --send to post.`);
    return 0;
  } catch (e) {
    if (e instanceof VerifyError) { log(`REFUSED: ${e.message}`); return 1; }
    log(`ERROR: ${e.message}`); return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c));
