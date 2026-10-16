// Shared logic for propose_authority.mjs / accept_authority.mjs / cancel_authority.mjs.
// Dry run by default (simulate), --send to submit. Only public keys are ever printed.
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "crypto";
import { PROGRAM_ID, CONFIG_PDA, expandHome, loadKeypair, rpcUrl, readConfig } from "./set_attestor.mjs";
import fs from "fs";

export { PROGRAM_ID, CONFIG_PDA };
export const PENDING_PDA = PublicKey.findProgramAddressSync([Buffer.from("pending_authority")], PROGRAM_ID)[0];
const disc = (s) => createHash("sha256").update(s).digest().subarray(0, 8);
const PENDING_DISC = disc("account:PendingAuthority");

export function parseArgs(argv, { needNew = false, signerFlag = "--authority" } = {}) {
  const a = { cluster: "devnet", send: false, printSquads: false };
  a.signer = "~/.config/solana/id.json";
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--send") a.send = true;
    else if (k === "--print-squads") a.printSquads = true;
    else if (k === signerFlag) { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); a.signer = argv[++i]; }
    else if (k === "--new" || k === "--cluster" || k === "--new-authority") {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      a[k === "--new-authority" ? "newAuthority" : k.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument: ${k}`);
  }
  if (needNew && !a.new) throw new Error("--new <pubkey | keypair.json> is required");
  return a;
}

export function resolvePubkey(v) {
  const p = expandHome(v);
  if (fs.existsSync(p)) return loadKeypair(p).publicKey;
  return new PublicKey(v);
}

export function parsePending(data) {
  if (!data || data.length < 73 || !Buffer.from(data.subarray(0, 8)).equals(PENDING_DISC)) return null;
  return { proposed: new PublicKey(data.subarray(8, 40)), proposer: new PublicKey(data.subarray(40, 72)) };
}

export async function readPending(connection) {
  const info = await connection.getAccountInfo(PENDING_PDA, "confirmed");
  if (!info || info.lamports === 0) return null;
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("PendingAuthority is not owned by the CountyRoot program");
  return parsePending(info.data);
}

export function proposeIx(authority, newAuthority) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc("global:propose_authority"), newAuthority.toBuffer()]),
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: PENDING_PDA, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ] });
}

export function acceptIx(proposer, newAuthority) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data: disc("global:accept_authority"),
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
      { pubkey: PENDING_PDA, isSigner: false, isWritable: true },
      { pubkey: proposer, isSigner: false, isWritable: true },
      { pubkey: newAuthority, isSigner: true, isWritable: false },
    ] });
}

export function cancelIx(proposer, authority) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data: disc("global:cancel_authority"),
    keys: [
      { pubkey: CONFIG_PDA, isSigner: false, isWritable: false },
      { pubkey: PENDING_PDA, isSigner: false, isWritable: true },
      { pubkey: proposer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ] });
}

export function describeIx(ix) {
  return [
    `program   ${ix.programId.toBase58()}`,
    `data hex  ${ix.data.toString("hex")}`,
    `data b64  ${ix.data.toString("base64")}`,
    "accounts (in order):",
    ...ix.keys.map((k, i) => `  ${i}. ${k.pubkey.toBase58()}  ${k.isWritable ? "writable" : "readonly"}${k.isSigner ? ", signer" : ""}`),
  ];
}

export async function header(connection, log, cluster) {
  const cfg = await readConfig(connection);
  const pending = await readPending(connection);
  log(`cluster        ${cluster}`);
  log(`program        ${PROGRAM_ID.toBase58()}`);
  log(`authority      ${cfg.authority.toBase58()}`);
  log(`attestor       ${cfg.attestor.toBase58()}`);
  log(`paused         ${cfg.paused}`);
  log(`pending        ${pending ? `${pending.proposed.toBase58()} (proposed by ${pending.proposer.toBase58()})` : "none"}`);
  return { cfg, pending };
}

export async function submit({ connection, signer, ix, send, log }) {
  const tx = new Transaction().add(ix);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(signer);
  if (!send) {
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
  return { ok: true, sig };
}

export function refuse(log, errs) { for (const e of errs) log(`REFUSED: ${e}`); return { ok: false, errs }; }

export const conn = (cluster, c) => c || new Connection(rpcUrl(cluster), "confirmed");
export { loadKeypair, readConfig };
