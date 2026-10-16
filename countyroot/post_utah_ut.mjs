import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";

if (process.env.COUNTYROOT_ATTESTOR_KEYPAIR) process.env.ANCHOR_WALLET = process.env.COUNTYROOT_ATTESTOR_KEYPAIR.replace(/^~/, process.env.HOME);
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const programId = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
const idl = JSON.parse(fs.readFileSync("./target/idl/countyroot.json", "utf8"));
const program = new anchor.Program(idl, provider);

const fips = 49049;
const epoch = 1;
const nParcels = 269159;
const merkleRoot = Buffer.from("adce2c47705ca378f10d0d205958a89fe95cd46de5928da4160f6cf94a304e69", "hex");
const schema = Buffer.from("1b0a0a99e80b71583619941720ccd746c9bd03551ca906bcb0a333839b29a427", "hex");

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [countyRoot] = PublicKey.findProgramAddressSync(
  [Buffer.from("county_root"), Buffer.from(new BN(fips).toArray("le", 4)), Buffer.from(new BN(epoch).toArray("le", 4))],
  programId
);

const tx = await program.methods
  .postRoot(new BN(fips), new BN(epoch), new BN(nParcels), [...merkleRoot], [...schema])
  .accounts({
    config,
    countyRoot,
    attestor: provider.wallet.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log(tx);
console.log(countyRoot.toBase58());
