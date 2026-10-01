import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import BN from "bn.js";

const idl = JSON.parse(readFileSync("./target/idl/countyroot.json", "utf8"));
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const attestor = provider.wallet.publicKey;

const fips = 48453;
const epoch = 1;
const nParcels = new BN(386068);
const merkleRoot = Buffer.from(
  "3f875b9faf6f2410647790ca8d76ba391a3deeb691f1eba73d29b559982ac577",
  "hex"
);
const schema = createHash("sha256")
  .update("vara.land.leaf.travis.v1")
  .digest();

const fipsBuf = Buffer.alloc(4);
fipsBuf.writeUInt32LE(fips);
const epochBuf = Buffer.alloc(4);
epochBuf.writeUInt32LE(epoch);

const [config] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  program.programId
);
const [countyRoot] = PublicKey.findProgramAddressSync(
  [Buffer.from("county_root"), fipsBuf, epochBuf],
  program.programId
);

console.log("label      Travis.TX / Austin");
console.log("PDA       ", countyRoot.toBase58());

const sig = await program.methods
  .postRoot(fips, epoch, nParcels, [...merkleRoot], [...schema])
  .accounts({
    config,
    countyRoot,
    attestor,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log("signature", sig);
