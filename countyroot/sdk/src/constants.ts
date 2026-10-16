import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg");
/** Size of a legacy (v0) CountyRoot account: 8-byte discriminator + 90-byte body. */
export const COUNTY_ROOT_V0_LEN = 98;
/** v1 = v0 body + 1 trailing version byte at offset 98. */
export const COUNTY_ROOT_V1_LEN = 99;
export const CONFIG_LEN = 74;
export const PENDING_AUTHORITY_LEN = 73;
export const STATUS_ACTIVE = 1;
export const STATUS_RETRACTED = 2;
