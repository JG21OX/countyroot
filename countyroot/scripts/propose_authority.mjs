// Step 1: propose a new CountyRoot config authority (e.g. a Squads vault). Current authority signs.
//   node scripts/propose_authority.mjs --new <pubkey | keypair.json> [--authority ~/.config/solana/id.json] [--cluster devnet] [--send]
import { pathToFileURL } from "url";
import { parseArgs, resolvePubkey, header, proposeIx, submit, refuse, conn, loadKeypair, readPending } from "./authority_lib.mjs";
import { PublicKey } from "@solana/web3.js";

export async function run(argv, { connection, log = console.log } = {}) {
  const a = parseArgs(argv, { needNew: true });
  const signer = loadKeypair(a.signer);
  const proposed = resolvePubkey(a.new);
  connection = conn(a.cluster, connection);
  const { cfg, pending } = await header(connection, log, a.cluster);
  log(`signer         ${signer.publicKey.toBase58()}`);
  log(`propose        ${proposed.toBase58()}`);
  const errs = [];
  if (!signer.publicKey.equals(cfg.authority)) errs.push(`signer is not config.authority ${cfg.authority.toBase58()}`);
  if (proposed.equals(PublicKey.default)) errs.push("new authority is the zero/default pubkey");
  if (proposed.equals(cfg.authority)) errs.push("new authority is already the authority");
  if (errs.length) return refuse(log, errs);
  if (pending) log(`NOTE: this overwrites the existing proposal for ${pending.proposed.toBase58()}`);
  const r = await submit({ connection, signer, ix: proposeIx(signer.publicKey, proposed), send: a.send, log });
  if (r.ok && r.sig) {
    const p = await readPending(connection);
    if (!p || !p.proposed.equals(proposed)) return { ok: false, sig: r.sig, errs: ["pending account does not show the proposal"] };
    log(`DONE: proposed ${proposed.toBase58()}. It must now run accept_authority (or a Squads vault transaction).`);
    log(`signature ${r.sig}`);
  }
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv.slice(2)).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
