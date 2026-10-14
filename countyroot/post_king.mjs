import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const idl = JSON.parse(fs.readFileSync("target/idl/countyroot.json", "utf8"));
const program = new anchor.Program(idl, provider);

const fips = 53033;
const epoch = 1;
const nParcels = new BN("636761");
const merkleRoot = Buffer.from("67f21be721d59bfb1b38419b0d7e702a76f78cd54fb3e208887f7a9164e35dcd", "hex");
const schema = Buffer.from("e5486968dd5431a893a6957cd07f0842313f70b47ad2fb0cbc6a7444288aecdc", "hex");

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const [countyRoot] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("county_root"),
    Buffer.from(Uint32Array.of(fips).buffer),
    Buffer.from(Uint32Array.of(epoch).buffer),
  ],
  program.programId
);

console.log("label      King.WA / Seattle");
console.log("program    " + program.programId.toBase58());
console.log("attestor   " + provider.wallet.publicKey.toBase58());
console.log("config     " + config.toBase58());
console.log("pda        " + countyRoot.toBase58());

if (countyRoot.toBase58() !== "CuVxf2eQvRnuuicxdjNAMYdpnTtowXTAnXWE2EKVn43e") {
  throw new Error("PDA does not match King County");
}

const sig = await program.methods
  .postRoot(fips, epoch, nParcels, Array.from(merkleRoot), Array.from(schema))
  .accounts({
    config,
    countyRoot,
    attestor: provider.wallet.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log("signature  " + sig);
