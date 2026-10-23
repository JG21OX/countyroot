import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { decodeConfig, decodeCountyHead, decodeCountyRoot, decodePendingAuthority, CountyHead, CountyRoot } from "./accounts.js";
import { PROGRAM_ID, STATUS_ACTIVE, STATUS_RETRACTED, STATUS_SUPERSEDED } from "./constants.js";
import { parseEventsFromLogs, ParseResult } from "./events.js";
import { configPda, countyHeadPda, countyRootPda, pendingAuthorityPda } from "./pda.js";

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

export async function fetchCountyHead(conn: Connection, fips: number, commitment = DEFAULT_COMMITMENT, programId = PROGRAM_ID) {
  const d = await owned(conn, countyHeadPda(fips, programId), commitment, programId);
  return d ? decodeCountyHead(d) : null;
}

export interface Latest {
  head: CountyHead;
  /** latest_active_epoch, or 0 when the newest epoch was retracted and nothing replaced it yet. */
  epoch: number;
  root: CountyRoot | null;
}
/**
 * What to trust for a county right now: reads CountyHead and the latest ACTIVE root.
 * Returns null if the county has no head (never posted under program v2 / not migrated).
 * `root` is null when latest_active_epoch is 0 (latest retracted, decision D5: no silent fallback).
 */
export async function fetchLatest(conn: Connection, fips: number, commitment = DEFAULT_COMMITMENT, programId = PROGRAM_ID): Promise<Latest | null> {
  const head = await fetchCountyHead(conn, fips, commitment, programId);
  if (!head) return null;
  if (head.fips !== fips) throw new Error(`head fips ${head.fips} != ${fips}`);
  if (head.latestActiveEpoch === 0) return { head, epoch: 0, root: null };
  const root = await fetchCountyRoot(conn, fips, head.latestActiveEpoch, commitment, programId);
  if (!root) throw new Error(`head points at epoch ${head.latestActiveEpoch} but the account does not exist`);
  if (root.status !== STATUS_ACTIVE) throw new Error(`head points at epoch ${head.latestActiveEpoch} but its status is ${root.status}`);
  return { head, epoch: head.latestActiveEpoch, root };
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
      if (ev.name === "HeadUpdated") {
        const key: PublicKey = ev.data.countyHead;
        const d = await owned(conn, key, commitment, programId).catch(() => null);
        const h = d ? decodeCountyHead(d) : null;
        const ok = !!h && h.fips === ev.data.fips && h.latestEpoch === ev.data.latestEpoch && h.latestActiveEpoch === ev.data.latestActiveEpoch;
        out.crossCheck.push({ event: ev.name, account: key.toBase58(), ok, note: !h ? "head missing" : ok ? "head matches" : `head is now epoch ${h.latestEpoch} / active ${h.latestActiveEpoch} (later post?)` });
        continue;
      }
      if (!["RootPosted", "RootPostedV2", "RootUpdated", "RootRetracted", "RootRetractedV2", "RootSuperseded", "RootMigrated", "RootClosed"].includes(ev.name)) continue;
      const key: PublicKey = ev.data.countyRoot;
      const d = await owned(conn, key, commitment, programId).catch(() => null);
      const acct: CountyRoot | null = d ? decodeCountyRoot(d) : null;
      const root: Buffer = ev.data.newRoot ?? ev.data.merkleRoot;
      let ok: boolean, note: string;
      if (ev.name === "RootClosed") { ok = !acct; note = acct ? "account exists again (re-posted after close)" : "account closed"; }
      else if (!acct) { ok = false; note = "account no longer exists (closed later?)"; }
      else if (acct.fips !== ev.data.fips || acct.epoch !== ev.data.epoch) { ok = false; note = "fips/epoch mismatch"; }
      else if (ev.name === "RootRetracted" || ev.name === "RootRetractedV2") { ok = acct.status === STATUS_RETRACTED; note = ok ? "retracted" : `status ${acct.status}`; }
      else if (ev.name === "RootSuperseded") {
        ok = acct.status === STATUS_SUPERSEDED || acct.status === STATUS_RETRACTED;
        note = acct.status === STATUS_SUPERSEDED ? `superseded by epoch ${acct.provenance?.supersededBy ?? ev.data.supersededBy}` : acct.status === STATUS_RETRACTED ? "superseded, later retracted" : `status ${acct.status}`;
      }
      else if (ev.name === "RootMigrated") {
        ok = !!acct.provenance && acct.provenance.manifestSha256.equals(ev.data.manifestSha256);
        note = ok ? "manifest hash matches" : "manifest hash differs";
      }
      else if (ev.name === "RootPostedV2") {
        ok = acct.merkleRoot.equals(root) && !!acct.provenance && acct.provenance.manifestSha256.equals(ev.data.manifestSha256);
        note = ok ? (acct.status === STATUS_ACTIVE ? "root + manifest match; active" : `root + manifest match; now status ${acct.status}`) : "root/manifest differs from account";
      }
      else { ok = acct.merkleRoot.equals(root); note = ok ? "root matches current account" : "root differs from current account (updated later?)"; }
      out.crossCheck.push({ event: ev.name, account: key.toBase58(), ok, note });
    }
  }
  return out;
}
