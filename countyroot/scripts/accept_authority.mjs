// Step 2: accept the pending CountyRoot config authority. Signed by the PROPOSED key.
//   node scripts/accept_authority.mjs [--signer <proposed keypair.json>] [--cluster devnet] [--send]
// For a Squads vault (cannot sign here), print the instruction to paste into a Squads custom transaction:
//   node scripts/accept_authority.mjs --print-squads [--new-authority <vault pubkey>] [--cluster devnet]
import { pathToFileURL } from "url";
import { parseArgs, resolvePubkey, header, acceptIx, describeIx, submit, refuse, conn, loadKeypair, readConfig } from "./authority_lib.mjs";

export async function run(argv, { connection, log = console.log } = {}) {
  const a = parseArgs(argv, { signerFlag: "--signer" });
  connection = conn(a.cluster, connection);
  const { cfg, pending } = await header(connection, log, a.cluster);
  if (!pending) return refuse(log, ["there is no pending proposal"]);
  if (!pending.proposer.equals(cfg.authority)) return refuse(log, ["pending proposal was made by a previous authority (StaleProposal); propose again"]);

  if (a.printSquads) {
    const vault = a.newAuthority ? resolvePubkey(a.newAuthority) : pending.proposed;
    if (!vault.equals(pending.proposed)) return refuse(log, [`${vault.toBase58()} is not the proposed authority ${pending.proposed.toBase58()}`]);
    log("Squads custom transaction (the vault is the signer; Squads signs it by CPI):");
    for (const l of describeIx(acceptIx(pending.proposer, vault))) log(l);
    return { ok: true, printed: true };
  }

  const signer = loadKeypair(a.signer);
  log(`signer         ${signer.publicKey.toBase58()}`);
  if (!signer.publicKey.equals(pending.proposed))
    return refuse(log, [`signer is not the proposed authority ${pending.proposed.toBase58()}`]);
  const r = await submit({ connection, signer, ix: acceptIx(pending.proposer, signer.publicKey), send: a.send, log });
  if (r.ok && r.sig) {
    const after = await readConfig(connection);
    if (!after.authority.equals(signer.publicKey)) return { ok: false, sig: r.sig, errs: ["authority did not change"] };
    log(`DONE: authority is now ${after.authority.toBase58()}`);
    log(`signature ${r.sig}`);
  }
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv.slice(2)).then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
