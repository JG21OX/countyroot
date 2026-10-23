import { PublicKey } from "@solana/web3.js";
import { discriminator, Reader } from "./borsh.js";
import { COUNTY_ROOT_V0_LEN, COUNTY_ROOT_V2_LEN, FLAG_FETCHED_AT_IS_UPPER_BOUND, FLAG_MIGRATED, OFF } from "./constants.js";

export interface Config { authority: PublicKey; attestor: PublicKey; paused: boolean; bump: number; }
export interface CountyRoot {
  fips: number; epoch: number; nParcels: bigint; merkleRoot: Buffer; schema: Buffer;
  status: number; postedAt: bigint; bump: number;
  /** 0 for legacy 98-byte accounts; byte 98 for 99-byte (v1+) accounts. */
  version: number;
  /** v2 provenance tail; null for legacy (version < 2) accounts. */
  provenance: Provenance | null;
}
export interface Provenance {
  manifestSha256: Buffer;
  /** All zeros for migrated roots whose raw download was not archived (flags.migrated). */
  sourceSha256: Buffer;
  packetSha256: Buffer;
  /** Unix seconds; 0 = the county does not publish an edit date. */
  dataAsOf: bigint;
  fetchedAt: bigint;
  /** 0 for migrated roots (unknown). */
  postedSlot: bigint;
  statusChangedAt: bigint;
  /** Epoch that replaced this one (SUPERSEDED), else 0. */
  supersededBy: number;
  retractReason: number;
  leafVersion: number;
  flags: number;
  migrated: boolean;
  /** fetchedAt is only a "fetched no later than" bound (no recorded download time). */
  fetchedAtIsUpperBound: boolean;
}
export interface CountyHead { fips: number; latestEpoch: number; latestActiveEpoch: number; nEpochs: number; updatedAt: bigint; bump: number; }
export interface PendingAuthority { proposed: PublicKey; proposer: PublicKey; bump: number; }

export const ACCOUNT_DISCRIMINATORS = {
  Config: discriminator("account:Config"),
  CountyRoot: discriminator("account:CountyRoot"),
  PendingAuthority: discriminator("account:PendingAuthority"),
  CountyHead: discriminator("account:CountyHead"),
};

function body(data: Buffer | Uint8Array, name: keyof typeof ACCOUNT_DISCRIMINATORS): Reader {
  const b = Buffer.from(data);
  if (b.length < 8 || !b.subarray(0, 8).equals(ACCOUNT_DISCRIMINATORS[name])) throw new Error(`not a ${name} account`);
  const r = new Reader(b); r.off = 8; return r;
}

export function decodeConfig(data: Buffer | Uint8Array): Config {
  const r = body(data, "Config");
  return { authority: r.pubkey(), attestor: r.pubkey(), paused: r.bool(), bump: r.u8() };
}

export function decodeCountyRoot(data: Buffer | Uint8Array): CountyRoot {
  const b = Buffer.from(data);
  const r = body(b, "CountyRoot");
  const v = {
    fips: r.u32(), epoch: r.u32(), nParcels: r.u64(), merkleRoot: r.bytes32(), schema: r.bytes32(),
    status: r.u8(), postedAt: r.i64(), bump: r.u8(), version: 0, provenance: null as Provenance | null,
  };
  v.version = b.length > COUNTY_ROOT_V0_LEN ? b[COUNTY_ROOT_V0_LEN] : 0;
  if (v.version >= 2) {
    if (b.length < COUNTY_ROOT_V2_LEN) throw new Error(`CountyRoot version ${v.version} but only ${b.length} bytes`);
    const h = (o: number) => Buffer.from(b.subarray(o, o + 32));
    const flags = b[OFF.FLAGS];
    v.provenance = {
      manifestSha256: h(OFF.MANIFEST_SHA256), sourceSha256: h(OFF.SOURCE_SHA256), packetSha256: h(OFF.PACKET_SHA256),
      dataAsOf: b.readBigInt64LE(OFF.DATA_AS_OF), fetchedAt: b.readBigInt64LE(OFF.FETCHED_AT),
      postedSlot: b.readBigUInt64LE(OFF.POSTED_SLOT), statusChangedAt: b.readBigInt64LE(OFF.STATUS_CHANGED_AT),
      supersededBy: b.readUInt32LE(OFF.SUPERSEDED_BY), retractReason: b[OFF.RETRACT_REASON],
      leafVersion: b[OFF.LEAF_VERSION], flags, migrated: (flags & FLAG_MIGRATED) !== 0,
      fetchedAtIsUpperBound: (flags & FLAG_FETCHED_AT_IS_UPPER_BOUND) !== 0,
    };
  }
  return v;
}

export function decodePendingAuthority(data: Buffer | Uint8Array): PendingAuthority {
  const r = body(data, "PendingAuthority");
  return { proposed: r.pubkey(), proposer: r.pubkey(), bump: r.u8() };
}

export function decodeCountyHead(data: Buffer | Uint8Array): CountyHead {
  const r = body(data, "CountyHead");
  return { fips: r.u32(), latestEpoch: r.u32(), latestActiveEpoch: r.u32(), nEpochs: r.u32(), updatedAt: r.i64(), bump: r.u8() };
}
