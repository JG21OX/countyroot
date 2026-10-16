import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";

const PROGRAM_ID = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
const FIPS = 12086;
const EPOCH = 2;
const ROOT_PATH = process.env.ROOT_PATH || (process.env.HOME + "/Downloads/MiamiDade.FL/MiamiDade.FL.2.2026-10.root.json");

if (process.env.COUNTYROOT_ATTESTOR_KEYPAIR) process.env.ANCHOR_WALLET = process.env.COUNTYROOT_ATTESTOR_KEYPAIR.replace(/^~/, process.env.HOME);
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const idl = JSON.parse(fs.readFileSync("./target/idl/countyroot.json", "utf8"));
const program = new anchor.Program(idl, provider);

const doc = JSON.parse(fs.readFileSync(ROOT_PATH, "utf8"));
const merkleRoot = Buffer.from(doc.merkle_root, "hex");
const schema = Buffer.alloc(32);
Buffer.from(doc.leaf || "sha256(utf8 parcel_id|acres_6dp|lot_sqft_2dp)").copy(schema);

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
const [countyRoot] = PublicKey.findProgramAddressSync(
  [Buffer.from("county_root"), u32le(FIPS), u32le(EPOCH)],
  PROGRAM_ID
);

const sig = await program.methods
  .postRoot(FIPS, EPOCH, new BN(doc.n_parcels), [...merkleRoot], [...schema])
  .accounts({
    config,
    countyRoot,
    attestor: provider.wallet.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log("label", doc.label);
console.log("fips", FIPS);
console.log("epoch", EPOCH);
console.log("pda", countyRoot.toBase58());
console.log("signature", sig);
