import { PublicKey } from "@solana/web3.js";
import { discriminator, Reader } from "./borsh.js";
import { COUNTY_ROOT_V0_LEN } from "./constants.js";

export interface Config { authority: PublicKey; attestor: PublicKey; paused: boolean; bump: number; }
export interface CountyRoot {
  fips: number; epoch: number; nParcels: bigint; merkleRoot: Buffer; schema: Buffer;
  status: number; postedAt: bigint; bump: number;
  /** 0 for legacy 98-byte accounts; byte 98 for 99-byte (v1+) accounts. */
  version: number;
}
export interface PendingAuthority { proposed: PublicKey; proposer: PublicKey; bump: number; }

export const ACCOUNT_DISCRIMINATORS = {
  Config: discriminator("account:Config"),
  CountyRoot: discriminator("account:CountyRoot"),
  PendingAuthority: discriminator("account:PendingAuthority"),
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
    status: r.u8(), postedAt: r.i64(), bump: r.u8(), version: 0,
  };
  v.version = b.length > COUNTY_ROOT_V0_LEN ? b[COUNTY_ROOT_V0_LEN] : 0;
  return v;
}

export function decodePendingAuthority(data: Buffer | Uint8Array): PendingAuthority {
  const r = body(data, "PendingAuthority");
  return { proposed: r.pubkey(), proposer: r.pubkey(), bump: r.u8() };
}
