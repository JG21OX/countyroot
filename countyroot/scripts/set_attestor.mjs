// Rotate the CountyRoot attestor (posting key). Authority-only.
//
//   node scripts/set_attestor.mjs --new <pubkey | path/to/keypair.json> \
//        [--authority ~/.config/solana/id.json] [--cluster devnet] [--send]
//
// Default is a DRY RUN: reads Config, runs every check, simulates the transaction.
// Add --send to submit. Secret key bytes are never printed or logged; only public keys.
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, clusterApiUrl } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import { pathToFileURL } from "url";

export const PROGRAM_ID = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
export const CONFIG_PDA = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
const CONFIG_DISC = createHash("sha256").update("account:Config").digest().subarray(0, 8);
const SET_ATTESTOR_DISC = createHash("sha256").update("global:set_attestor").digest().subarray(0, 8);

export function expandHome(p) {
  return p && p.startsWith("~") ? os.homedir() + p.slice(1) : p;
}

export function parseArgs(argv) {
  const a = { authority: "~/.config/solana/id.json", cluster: "devnet", send: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--send") a.send = true;
    else if (k === "--new" || k === "--authority" || k === "--cluster") {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      a[k.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.new) throw new Error("--new <pubkey | keypair.json> is required");
  return a;
}

export function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(expandHome(path), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// --new may be a base58 pubkey or a keypair file; only the public key is kept.
export function resolveNewAttestor(v) {
  const p = expandHome(v);
  if (fs.existsSync(p)) return loadKeypair(p).publicKey;
  return new PublicKey(v);
}

export function rpcUrl(cluster) {
  if (cluster.startsWith("http")) return cluster;
  if (cluster === "mainnet" || cluster === "mainnet-beta") return clusterApiUrl("mainnet-beta");
  if (cluster === "devnet" || cluster === "testnet") return clusterApiUrl(cluster);
  if (cluster === "localnet" || cluster === "localhost") return "http://127.0.0.1:8899";
  throw new Error(`unknown cluster: ${cluster}`);
}

export function parseConfig(data) {
  if (!data || data.length < 74) throw new Error("Config account missing or too short");
  if (!Buffer.from(data.subarray(0, 8)).equals(CONFIG_DISC)) throw new Error("not a CountyRoot Config account");
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    attestor: new PublicKey(data.subarray(40, 72)),
    paused: data[72] === 1,
  };
}

export async function readConfig(connection) {
  const info = await connection.getAccountInfo(CONFIG_PDA, "confirmed");
  if (!info) throw new Error(`Config ${CONFIG_PDA.toBase58()} not found on this cluster`);
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("Config is not owned by the CountyRoot program");
  return parseConfig(info.data);
}

// Returns a list of reasons to refuse (empty = OK).
export function checkRotation(cfg, signer, newAttestor) {
  const errs = [];
  if (!signer.equals(cfg.authority))
    errs.push(`signer ${signer.toBase58()} is not config.authority ${cfg.authority.toBase58()}`);
  if (newAttestor.equals(PublicKey.default)) errs.push("new attestor is the zero/default pubkey");
  if (newAttestor.equals(cfg.attestor)) errs.push("new attestor is already the current attestor");
  return errs;
}

export function setAttestorIx(authority, newAttestor) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([SET_ATTESTOR_DISC, newAttestor.toBuffer()]),
  });
}

export async function run(argv, { connection, log = console.log } = {}) {
  const args = parseArgs(argv);
  const authority = loadKeypair(args.authority);
  const newAttestor = resolveNewAttestor(args.new);
  connection = connection || new Connection(rpcUrl(args.cluster), "confirmed");

  const cfg = await readConfig(connection);
  log(`cluster        ${args.cluster}`);
  log(`program        ${PROGRAM_ID.toBase58()}`);
  log(`config         ${CONFIG_PDA.toBase58()}`);
  log(`authority      ${cfg.authority.toBase58()}`);
  log(`attestor (now) ${cfg.attestor.toBase58()}`);
  log(`paused         ${cfg.paused}`);
  log(`signer         ${authority.publicKey.toBase58()}`);
  log(`attestor (new) ${newAttestor.toBase58()}`);

  const errs = checkRotation(cfg, authority.publicKey, newAttestor);
  if (errs.length) {
    for (const e of errs) log(`REFUSED: ${e}`);
    return { ok: false, errs };
  }

  const tx = new Transaction().add(setAttestorIx(authority.publicKey, newAttestor));
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(authority);

  if (!args.send) {
    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      log(`SIMULATION FAILED: ${JSON.stringify(sim.value.err)}`);
      for (const l of sim.value.logs || []) log(`  ${l}`);
      return { ok: false, errs: ["simulation failed"] };
    }
    log("DRY RUN OK: simulation succeeded. Re-run with --send to submit.");
    return { ok: true, dryRun: true };
  }

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  const after = await readConfig(connection);
  if (!after.attestor.equals(newAttestor)) {
    log(`ERROR: sent ${sig} but Config.attestor is ${after.attestor.toBase58()}`);
    return { ok: false, sig, errs: ["attestor did not change"] };
  }
  log(`DONE: attestor is now ${after.attestor.toBase58()}`);
  log(`signature ${sig}`);
  return { ok: true, sig };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
