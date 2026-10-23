// Pause or unpause CountyRoot (authority only). Pausing blocks posts, retracts, closes and the Devnet migration.
//   node scripts/set_paused.mjs --paused true|false [--authority ~/.config/solana/id.json] [--cluster devnet] [--send]
// DRY RUN by default (simulates). Only public keys are printed.
import { pathToFileURL } from "url";
import fs from "fs";
import { createHash } from "crypto";
import { TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, CONFIG_PDA, header, submit, refuse, conn, loadKeypair, readConfig } from "./authority_lib.mjs";

export function setPausedIx(authority, paused) {
  const data = Buffer.concat([createHash("sha256").update("global:set_paused").digest().subarray(0, 8), Buffer.from([paused ? 1 : 0])]);
  return new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    { pubkey: CONFIG_PDA, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false } ] });
}

export async function run(argv, { connection, log = console.log } = {}) {
  const a = { cluster: "devnet", send: false, authority: "~/.config/solana/id.json" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--send") a.send = true;
    else if (["--paused", "--authority", "--cluster"].includes(k)) { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); a[k.slice(2)] = argv[++i]; }
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!["true", "false"].includes(a.paused)) throw new Error("--paused true|false is required");
  const paused = a.paused === "true";
  const signer = loadKeypair(a.authority);
  connection = conn(a.cluster, connection);
  const { cfg } = await header(connection, log, a.cluster);
  log(`signer         ${signer.publicKey.toBase58()}`);
  log(`set paused     ${paused}`);
  if (!signer.publicKey.equals(cfg.authority)) return refuse(log, [`signer is not config.authority ${cfg.authority.toBase58()}`]);
  if (cfg.paused === paused) { log(`already paused=${paused}; nothing to do`); return { ok: true }; }
  const r = await submit({ connection, signer, ix: setPausedIx(signer.publicKey, paused), send: a.send, log });
  if (r.ok && r.sig) {
    const now = await readConfig(connection);
    if (now.paused !== paused) return { ok: false, sig: r.sig, errs: ["Config does not show the change"] };
    log(`DONE: paused=${paused}  signature ${r.sig}`);
  }
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  run(process.argv.slice(2)).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(2); });
