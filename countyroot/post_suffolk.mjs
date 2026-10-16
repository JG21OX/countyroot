import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import { guardProgram } from "./scripts/preflight.mjs";

const idl = JSON.parse(fs.readFileSync("target/idl/countyroot.json", "utf8"));
const secret = JSON.parse(fs.readFileSync((process.env.COUNTYROOT_ATTESTOR_KEYPAIR || process.env.ANCHOR_WALLET || "~/.config/solana/id.json").replace(/^~/, process.env.HOME), "utf8"));
const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, {});
const program = new anchor.Program(idl, provider);
guardProgram(program); // verify the packet before sending (scripts/preflight.mjs)
const BN = anchor.default?.BN ?? anchor.BN;

const fips = 25025;
const epoch = 1;
const nParcels = 98441;
const merkleRoot = Buffer.from("0d806a9845cb964cbff9552a9565f6a53e54807d6691770c72c2e6d21e87f112", "hex");
const schema = Buffer.alloc(32);
Buffer.from("map_par_id|acres_q32|landuse0").copy(schema);

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("county_root"), Buffer.from([0xc1, 0x61, 0x00, 0x00]), Buffer.from([1, 0, 0, 0])],
  program.programId
);
console.log("label  Suffolk.MA / Boston");
console.log("PDA   ", pda.toBase58());

const sig = await program.methods
  .postRoot(fips, epoch, new BN(nParcels), [...merkleRoot], [...schema])
  .accounts({ config, countyRoot: pda, attestor: wallet.publicKey })
  .rpc();
console.log("signature", sig);
