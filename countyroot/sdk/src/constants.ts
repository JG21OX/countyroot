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
/** Replaced by a later epoch; proofs still verify as historical, not current. */
export const STATUS_SUPERSEDED = 3;
/** v2 = original 98-byte body + version byte + provenance tail (program 0.3 / SDK 0.3.0). */
export const COUNTY_ROOT_V2_LEN = 256;
export const COUNTY_HEAD_LEN = 48;
/** Byte offsets of the v2 tail (after the unchanged 98-byte body). */
export const OFF = {
  VERSION: 98, MANIFEST_SHA256: 99, SOURCE_SHA256: 131, PACKET_SHA256: 163, DATA_AS_OF: 195, FETCHED_AT: 203,
  POSTED_SLOT: 211, STATUS_CHANGED_AT: 219, SUPERSEDED_BY: 227, RETRACT_REASON: 231, LEAF_VERSION: 232, FLAGS: 233, RESERVED: 234,
} as const;
export const FLAG_MIGRATED = 1;
export const REASON = { NONE: 0, SUPERSEDED: 1, PII: 2, SOURCE_ERROR: 3, DUPLICATE: 4, BUILD_ERROR: 5, OTHER: 255 } as const;
export const REASON_NAMES: Record<number, string> = { 0: "none", 1: "superseded", 2: "pii", 3: "source_error", 4: "duplicate", 5: "build_error", 255: "other" };
export const STATUS_NAMES: Record<number, string> = { 1: "active", 2: "retracted", 3: "superseded" };
