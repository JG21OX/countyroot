import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";

export const discriminator = (preimage: string): Buffer =>
  createHash("sha256").update(preimage).digest().subarray(0, 8);

/** Minimal little-endian Borsh reader. */
export class Reader {
  off = 0;
  constructor(readonly buf: Buffer) {}
  need(n: number) { if (this.off + n > this.buf.length) throw new Error("buffer too short"); }
  remaining() { return this.buf.length - this.off; }
  u8() { this.need(1); return this.buf[this.off++]; }
  bool() { const v = this.u8(); if (v > 1) throw new Error("invalid bool"); return v === 1; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return v; }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.off); this.off += 8; return v; }
  bytes32() { this.need(32); const v = Buffer.from(this.buf.subarray(this.off, this.off + 32)); this.off += 32; return v; }
  pubkey() { return new PublicKey(this.bytes32()); }
}
