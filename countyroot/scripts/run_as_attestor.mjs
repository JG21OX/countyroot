// Run any CountyRoot post/update/retract script (or batch) as the attestor key.
//
//   node scripts/run_as_attestor.mjs [--keypair <path>] [--cluster devnet] <script.mjs> [script args]
//
// Keypair: --keypair, else $COUNTYROOT_ATTESTOR_KEYPAIR, else ~/.config/solana/id.json.
// Sets ANCHOR_WALLET / ANCHOR_PROVIDER_URL / COUNTYROOT_ATTESTOR_KEYPAIR for the child (and any
// scripts a batch runs). Prints only the attestor public key.
import { execFileSync } from "child_process";
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import { rpcUrl } from "./set_attestor.mjs";

const argv = process.argv.slice(2);
let keypair = process.env.COUNTYROOT_ATTESTOR_KEYPAIR || "~/.config/solana/id.json";
let cluster = "devnet";
while (argv[0] === "--keypair" || argv[0] === "--cluster") {
  const k = argv.shift();
  if (!argv.length) throw new Error(`${k} needs a value`);
  if (k === "--keypair") keypair = argv.shift(); else cluster = argv.shift();
}
if (!argv.length) { console.error("usage: run_as_attestor.mjs [--keypair p] [--cluster c] <script.mjs> [args]"); process.exit(2); }
keypair = keypair.startsWith("~") ? os.homedir() + keypair.slice(1) : keypair;
const pub = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypair, "utf8")))).publicKey;
console.log(`attestor ${pub.toBase58()}  cluster ${cluster}`);
const env = { ...process.env, ANCHOR_WALLET: keypair, COUNTYROOT_ATTESTOR_KEYPAIR: keypair,
  ANCHOR_PROVIDER_URL: process.env.ANCHOR_PROVIDER_URL || rpcUrl(cluster) };
execFileSync("node", argv, { stdio: "inherit", env });
