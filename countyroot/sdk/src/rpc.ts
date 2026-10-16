import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { decodeConfig, decodeCountyRoot, decodePendingAuthority, CountyRoot } from "./accounts.js";
import { PROGRAM_ID } from "./constants.js";
import { parseEventsFromLogs, ParseResult } from "./events.js";
import { configPda, countyRootPda, pendingAuthorityPda } from "./pda.js";

export const DEFAULT_COMMITMENT: Commitment = "finalized";

async function owned(conn: Connection, key: PublicKey, commitment: Commitment, programId: PublicKey) {
  const info = await conn.getAccountInfo(key, commitment);
  if (!info) return null;
  if (!info.owner.equals(programId)) throw new Error(`${key.toBase58()} is not owned by ${programId.toBase58()}`);
  return info.data;
}

export async function fetchConfig(conn: Connection, commitment = DEFAULT_COMMITMENT, programId = PROGRAM_ID) {
  const d = await owned(conn, configPda(programId), commitment, programId);
  return d ? decodeConfig(d) : null;
}
export async function fetchCountyRoot(conn: Connection, fips: number, epoch: number, commitment = DEFAULT_COMMITMENT, programId = PROGRAM_ID) {
  const d = await owned(conn, countyRootPda(fips, epoch, programId), commitment, programId);
  return d ? decodeCountyRoot(d) : null;
}
export async function fetchPendingAuthority(conn: Connection, commitment = DEFAULT_COMMITMENT, programId = PROGRAM_ID) {
  const d = await owned(conn, pendingAuthorityPda(programId), commitment, programId);
  return d ? decodePendingAuthority(d) : null;
}

export interface TxEventsOptions { commitment?: "confirmed" | "finalized"; onTruncated?: "throw" | "flag"; crossCheck?: boolean; programId?: PublicKey; }
export interface TxEvents extends ParseResult { signature: string; slot: number; crossCheck?: CrossCheck[]; }
export interface CrossCheck { event: string; account: string; ok: boolean; note: string; }

/**
 * Fetch a transaction and return only trusted CountyRoot events (see parseEventsFromLogs).
 * Refuses failed transactions. Optional crossCheck compares root events with the CURRENT
 * account state (a later update/close can legitimately differ; that is reported, not thrown).
 */
export async function getTransactionEvents(conn: Connection, signature: string, opts: TxEventsOptions = {}): Promise<TxEvents> {
  const commitment = opts.commitment ?? "finalized";
  const programId = opts.programId ?? PROGRAM_ID;
  const tx = await conn.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta) throw new Error(`transaction ${signature} not found at ${commitment}`);
  if (tx.meta.err) throw new Error(`transaction ${signature} failed; its events are not valid`);
  const parsed = parseEventsFromLogs(tx.meta.logMessages ?? [], { programId, onTruncated: opts.onTruncated });
  const out: TxEvents = { ...parsed, signature, slot: tx.slot };
  if (opts.crossCheck) {
    out.crossCheck = [];
    for (const ev of parsed.events) {
      if (!["RootPosted", "RootUpdated", "RootRetracted", "RootClosed"].includes(ev.name)) continue;
      const key: PublicKey = ev.data.countyRoot;
      const d = await owned(conn, key, commitment, programId).catch(() => null);
      const acct: CountyRoot | null = d ? decodeCountyRoot(d) : null;
      const root: Buffer = ev.data.newRoot ?? ev.data.merkleRoot;
      let ok: boolean, note: string;
      if (ev.name === "RootClosed") { ok = !acct; note = acct ? "account exists again (re-posted after close)" : "account closed"; }
      else if (!acct) { ok = false; note = "account no longer exists (closed later?)"; }
      else if (acct.fips !== ev.data.fips || acct.epoch !== ev.data.epoch) { ok = false; note = "fips/epoch mismatch"; }
      else if (ev.name === "RootRetracted") { ok = acct.status === 2; note = ok ? "retracted" : `status ${acct.status}`; }
      else { ok = acct.merkleRoot.equals(root); note = ok ? "root matches current account" : "root differs from current account (updated later?)"; }
      out.crossCheck.push({ event: ev.name, account: key.toBase58(), ok, note });
    }
  }
  return out;
}
