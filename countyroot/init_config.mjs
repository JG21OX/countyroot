import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "fs";

const idl = JSON.parse(readFileSync("./target/idl/countyroot.json", "utf8"));

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = new anchor.Program(idl, provider);
const attestor = provider.wallet.publicKey;

const [config] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  program.programId
);

// init_config is restricted to the program's upgrade authority (checked on-chain via ProgramData).
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE);

console.log("program ", program.programId.toBase58());
console.log("attestor", attestor.toBase58());
console.log("config  ", config.toBase58());

const sig = await program.methods
  .initConfig(attestor)
  .accounts({
    config,
    payer: attestor,
    program: program.programId,
    programData,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log("signature", sig);
