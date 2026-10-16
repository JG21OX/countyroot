// Cancel a pending CountyRoot authority proposal. Current authority signs.
//   node scripts/cancel_authority.mjs [--authority ~/.config/solana/id.json] [--cluster devnet] [--send]
import { pathToFileURL } from "url";
import { parseArgs, header, cancelIx, submit, refuse, conn, loadKeypair, readPending } from "./authority_lib.mjs";

export async function run(argv, { connection, log = console.log } = {}) {
  const a = parseArgs(argv);
  const signer = loadKeypair(a.signer);
  connection = conn(a.cluster, connection);
  const { cfg, pending } = await header(connection, log, a.cluster);
  log(`signer         ${signer.publicKey.toBase58()}`);
  const errs = [];
  if (!signer.publicKey.equals(cfg.authority)) errs.push(`signer is not config.authority ${cfg.authority.toBase58()}`);
  if (!pending) errs.push("there is no pending proposal");
  if (errs.length) return refuse(log, errs);
  const r = await submit({ connection, signer, ix: cancelIx(pending.proposer, signer.publicKey), send: a.send, log });
  if (r.ok && r.sig) {
    if (await readPending(connection)) return { ok: false, sig: r.sig, errs: ["pending account still exists"] };
    log("DONE: proposal cancelled");
    log(`signature ${r.sig}`);
  }
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv.slice(2)).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
