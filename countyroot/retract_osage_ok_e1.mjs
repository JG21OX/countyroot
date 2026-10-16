// Retract fips 40113 epoch 1 (superseded by epoch 2; parcel IDs contained personal names). Run AFTER epoch 2 is posted and read back.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";

if (process.env.COUNTYROOT_ATTESTOR_KEYPAIR) process.env.ANCHOR_WALLET = process.env.COUNTYROOT_ATTESTOR_KEYPAIR.replace(/^~/, process.env.HOME);
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const programId = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
const program = new anchor.Program(JSON.parse(fs.readFileSync("./target/idl/countyroot.json", "utf8")), provider);
const fips = 40113;
const pda = (e) => PublicKey.findProgramAddressSync([Buffer.from("county_root"), Buffer.from(new BN(fips).toArray("le", 4)), Buffer.from(new BN(e).toArray("le", 4))], programId)[0];
if (!(await provider.connection.getAccountInfo(pda(2)))) throw new Error("epoch 2 is not posted yet; post it first");
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const tx = await program.methods.retractRoot().accounts({ config, countyRoot: pda(1), attestor: provider.wallet.publicKey }).rpc();
console.log(tx);
console.log(pda(1).toBase58());
