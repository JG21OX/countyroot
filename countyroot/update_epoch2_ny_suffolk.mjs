// Re-point NewYork.NY and Suffolk.MA epoch 2 roots to match the CSVs on R2.
// Run from ~/countyroot/countyroot:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json node update_epoch2_ny_suffolk.mjs
// Add --dry-run to only print the current vs new values.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";

const DRY = process.argv.includes("--dry-run");
if (process.env.COUNTYROOT_ATTESTOR_KEYPAIR) process.env.ANCHOR_WALLET = process.env.COUNTYROOT_ATTESTOR_KEYPAIR.replace(/^~/, process.env.HOME);
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const programId = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
const idl = JSON.parse(fs.readFileSync("./target/idl/countyroot.json", "utf8"));
const program = new anchor.Program(idl, provider);

// Schema: sha256("sha256(utf8 parcel_id|acres_6dp|lot_sqft_2dp)"), unchanged from the epoch 2 posts.
const schema = Buffer.from("1b0a0a99e80b71583619941720ccd746c9bd03551ca906bcb0a333839b29a427", "hex");

const updates = [
  { label: "NewYork.NY epoch 2", fips: 36061, epoch: 2, n: 42504,
    oldRoot: "58acc158b8a0b2c3d06484acae9f1aebdbbc0ac9cbf36d278a5167b4c2507dca",
    newRoot: "0319f27d0b4270d0682d0eb82dd0661cb487bc25b67192c962b1d46f293a9b2d" },
  { label: "Suffolk.MA epoch 2", fips: 25025, epoch: 2, n: 98829,
    oldRoot: "ceaff0b1",
    newRoot: "54f58daa4c71d09f3332394a3c64131d03d1bd3d191f6564a837b95949b5231a" },
];

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);

for (const u of updates) {
  const [countyRoot] = PublicKey.findProgramAddressSync(
    [Buffer.from("county_root"), Buffer.from(new BN(u.fips).toArray("le", 4)), Buffer.from(new BN(u.epoch).toArray("le", 4))],
    programId
  );
  const acct = await program.account.countyRoot.fetch(countyRoot);
  const current = Buffer.from(acct.merkleRoot).toString("hex");
  console.log(`\n${u.label}  PDA ${countyRoot.toBase58()}`);
  console.log(`  current ${current}  status ${acct.status}`);
  console.log(`  new     ${u.newRoot}`);
  if (current === u.newRoot) { console.log("  already up to date, skipping"); continue; }
  if (!current.startsWith(u.oldRoot)) { console.log("  current root is not the expected old root, skipping for safety"); continue; }
  if (DRY) { console.log("  dry run, not sending"); continue; }
  const sig = await program.methods
    .updateRoot(new BN(u.n), [...Buffer.from(u.newRoot, "hex")], [...schema])
    .accounts({ config, countyRoot, attestor: provider.wallet.publicKey })
    .rpc();
  console.log(`  signature ${sig}`);
}
