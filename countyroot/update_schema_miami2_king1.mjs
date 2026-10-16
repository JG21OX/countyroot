// Standardize on-chain schema for MiamiDade.FL epoch 2 and King.WA epoch 1.
// Root and n_parcels are unchanged; only the schema field is rewritten.
// Run from ~/countyroot/countyroot with ANCHOR_PROVIDER_URL and ANCHOR_WALLET set.
// Add --dry-run to only print the current vs new values.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import { createHash } from "crypto";
import { guardProgram } from "./scripts/preflight.mjs";

const DRY = process.argv.includes("--dry-run");
if (process.env.COUNTYROOT_ATTESTOR_KEYPAIR) process.env.ANCHOR_WALLET = process.env.COUNTYROOT_ATTESTOR_KEYPAIR.replace(/^~/, process.env.HOME);
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const programId = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
const idl = JSON.parse(fs.readFileSync("./target/idl/countyroot.json", "utf8"));
const program = new anchor.Program(idl, provider);
guardProgram(program); // verify the packet before sending (scripts/preflight.mjs)

const SCHEMA_STR = "sha256(utf8 parcel_id|acres_6dp|lot_sqft_2dp)";
const schema = createHash("sha256").update(SCHEMA_STR).digest();
if (schema.toString("hex") !== "1b0a0a99e80b71583619941720ccd746c9bd03551ca906bcb0a333839b29a427") throw new Error("schema hash mismatch");

const updates = [
  { label: "MiamiDade.FL epoch 2", fips: 12086, epoch: 2, n: 119392,
    root: "04d6552ce242445f7439d919170667fe18f17421f4370e8b741e59766c6d9743" },
  { label: "King.WA epoch 1", fips: 53033, epoch: 1, n: 636761,
    root: "67f21be721d59bfb1b38419b0d7e702a76f78cd54fb3e208887f7a9164e35dcd" },
];

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

for (const u of updates) {
  const [countyRoot] = PublicKey.findProgramAddressSync(
    [Buffer.from("county_root"), Buffer.from(new BN(u.fips).toArray("le", 4)), Buffer.from(new BN(u.epoch).toArray("le", 4))],
    programId
  );
  const a = await program.account.countyRoot.fetch(countyRoot);
  const curRoot = Buffer.from(a.merkleRoot).toString("hex");
  const curSchema = Buffer.from(a.schema).toString("hex");
  console.log(`\n${u.label}  PDA ${countyRoot.toBase58()}`);
  console.log(`  root    ${curRoot}  n ${a.nParcels.toString()}  status ${a.status}`);
  console.log(`  schema  ${curSchema}`);
  console.log(`  new     ${schema.toString("hex")}`);
  if (curSchema === schema.toString("hex")) { console.log("  already standardized, skipping"); continue; }
  if (curRoot !== u.root || a.nParcels.toString() !== String(u.n)) { console.log("  root or n_parcels not as expected, skipping for safety"); continue; }
  if (DRY) { console.log("  dry run, not sending"); continue; }
  const sig = await program.methods
    .updateRoot(new BN(u.n), [...Buffer.from(u.root, "hex")], [...schema])
    .accounts({ config, countyRoot, attestor: provider.wallet.publicKey })
    .rpc();
  console.log(`  signature ${sig}`);
}
