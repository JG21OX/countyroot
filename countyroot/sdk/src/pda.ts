import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants.js";

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

export function configPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}
export function countyRootPda(fips: number, epoch: number, programId: PublicKey = PROGRAM_ID): PublicKey {
  if (!Number.isInteger(fips) || fips < 0 || fips > 0xffffffff) throw new Error("fips must be a u32");
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) throw new Error("epoch must be a u32");
  return PublicKey.findProgramAddressSync([Buffer.from("county_root"), u32le(fips), u32le(epoch)], programId)[0];
}
export function pendingAuthorityPda(programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pending_authority")], programId)[0];
}
