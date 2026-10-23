import { PublicKey } from "@solana/web3.js";
import { discriminator, Reader } from "./borsh.js";
import { PROGRAM_ID } from "./constants.js";

type Field = [string, "pubkey" | "u8" | "bool" | "u32" | "u64" | "i64" | "bytes32"];
// Field order must match the #[event] structs in programs/countyroot/src/lib.rs.
// Fields marked optional were appended later; older events simply lack them.
const SCHEMAS: Record<string, { fields: Field[]; optional?: Field[] }> = {
  ConfigInitialized: { fields: [["authority", "pubkey"], ["attestor", "pubkey"]] },
  RootPosted: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["nParcels", "u64"], ["merkleRoot", "bytes32"], ["schema", "bytes32"], ["attestor", "pubkey"], ["slot", "u64"], ["ts", "i64"]], optional: [["version", "u8"]] },
  RootUpdated: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["oldNParcels", "u64"], ["newNParcels", "u64"], ["oldRoot", "bytes32"], ["newRoot", "bytes32"], ["oldSchema", "bytes32"], ["newSchema", "bytes32"], ["attestor", "pubkey"], ["slot", "u64"], ["ts", "i64"]], optional: [["version", "u8"]] },
  RootRetracted: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["merkleRoot", "bytes32"], ["prevStatus", "u8"], ["attestor", "pubkey"], ["slot", "u64"], ["ts", "i64"]], optional: [["version", "u8"]] },
  RootClosed: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["merkleRoot", "bytes32"], ["authority", "pubkey"], ["lamportsReturned", "u64"], ["slot", "u64"], ["ts", "i64"]], optional: [["version", "u8"]] },
  RootPostedV2: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["nParcels", "u64"], ["merkleRoot", "bytes32"], ["schema", "bytes32"], ["manifestSha256", "bytes32"], ["sourceSha256", "bytes32"], ["packetSha256", "bytes32"], ["dataAsOf", "i64"], ["fetchedAt", "i64"], ["leafVersion", "u8"], ["supersededEpoch", "u32"], ["attestor", "pubkey"], ["slot", "u64"], ["ts", "i64"], ["version", "u8"]] },
  RootSuperseded: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["supersededBy", "u32"], ["slot", "u64"], ["ts", "i64"]] },
  RootRetractedV2: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["merkleRoot", "bytes32"], ["prevStatus", "u8"], ["reason", "u8"], ["attestor", "pubkey"], ["slot", "u64"], ["ts", "i64"], ["version", "u8"]] },
  RootMigrated: { fields: [["countyRoot", "pubkey"], ["fips", "u32"], ["epoch", "u32"], ["oldLen", "u32"], ["manifestSha256", "bytes32"], ["sourceSha256", "bytes32"], ["packetSha256", "bytes32"], ["dataAsOf", "i64"], ["fetchedAt", "i64"], ["leafVersion", "u8"], ["attestor", "pubkey"], ["slot", "u64"], ["ts", "i64"]] },
  HeadUpdated: { fields: [["countyHead", "pubkey"], ["fips", "u32"], ["latestEpoch", "u32"], ["latestActiveEpoch", "u32"], ["nEpochs", "u32"], ["slot", "u64"], ["ts", "i64"]] },
  PauseChanged: { fields: [["authority", "pubkey"], ["old", "bool"], ["new", "bool"], ["slot", "u64"], ["ts", "i64"]] },
  AttestorChanged: { fields: [["authority", "pubkey"], ["old", "pubkey"], ["new", "pubkey"], ["slot", "u64"], ["ts", "i64"]] },
  AuthorityProposed: { fields: [["authority", "pubkey"], ["proposed", "pubkey"], ["slot", "u64"], ["ts", "i64"]] },
  AuthorityChanged: { fields: [["old", "pubkey"], ["new", "pubkey"], ["slot", "u64"], ["ts", "i64"]] },
  AuthorityProposalCancelled: { fields: [["authority", "pubkey"], ["proposed", "pubkey"], ["slot", "u64"], ["ts", "i64"]] },
};

export const EVENT_NAMES = Object.keys(SCHEMAS);
const BY_DISC = new Map(EVENT_NAMES.map((n) => [discriminator(`event:${n}`).toString("hex"), n]));

export interface CountyRootEvent { name: string; data: Record<string, any>; /** index of the log line */ logIndex: number; }

function read(r: Reader, t: Field[1]) {
  switch (t) {
    case "pubkey": return r.pubkey();
    case "u8": return r.u8();
    case "bool": return r.bool();
    case "u32": return r.u32();
    case "u64": return r.u64();
    case "i64": return r.i64();
    case "bytes32": return r.bytes32();
  }
}

/** Decode one event payload (discriminator + Borsh body). Returns null for unknown discriminators. */
export function decodeEventData(raw: Buffer): { name: string; data: Record<string, any> } | null {
  if (raw.length < 8) return null;
  const name = BY_DISC.get(raw.subarray(0, 8).toString("hex"));
  if (!name) return null;
  const s = SCHEMAS[name];
  const r = new Reader(raw); r.off = 8;
  const data: Record<string, any> = {};
  for (const [k, t] of s.fields) data[k] = read(r, t);
  for (const [k, t] of s.optional ?? []) if (r.remaining() > 0) data[k] = read(r, t);
  if (s.optional?.some(([k]) => k === "version") && data.version === undefined) data.version = 0;
  return { name, data };
}

export class TruncatedLogsError extends Error {
  constructor() { super("transaction logs were truncated; events may be missing. Re-check against account state."); }
}

export interface ParseOptions {
  programId?: PublicKey;
  /** "throw" (default) refuses truncated logs; "flag" returns events with truncated=true. */
  onTruncated?: "throw" | "flag";
}
export interface ParseResult { events: CountyRootEvent[]; truncated: boolean; ignored: number; }

const INVOKE = /^Program (\S+) invoke \[(\d+)\]$/;
const SUCCESS = /^Program (\S+) success$/;
const FAILED = /^Program (\S+) failed: /;

/**
 * The safe event rule: only "Program data:" lines emitted while the CountyRoot program is the
 * innermost executing frame are accepted. Lines from any other program, including CPI children
 * called by CountyRoot or programs that call CountyRoot, are ignored. Malformed frame structure
 * throws. Callers must also check that the transaction succeeded (meta.err === null).
 */
export function parseEventsFromLogs(logs: string[], opts: ParseOptions = {}): ParseResult {
  const pid = (opts.programId ?? PROGRAM_ID).toBase58();
  const stack: string[] = [];
  const events: CountyRootEvent[] = [];
  let truncated = false, ignored = 0;
  logs.forEach((line, i) => {
    if (line === "Log truncated") { truncated = true; return; }
    let m;
    if ((m = INVOKE.exec(line))) {
      if (Number(m[2]) !== stack.length + 1) throw new Error(`log ${i}: invoke depth ${m[2]} does not match frame stack ${stack.length}`);
      stack.push(m[1]); return;
    }
    if ((m = SUCCESS.exec(line)) || (m = FAILED.exec(line))) {
      if (stack[stack.length - 1] !== m[1]) throw new Error(`log ${i}: ${m[1]} exited but ${stack[stack.length - 1]} is executing`);
      stack.pop(); return;
    }
    if (line.startsWith("Program data: ")) {
      if (stack[stack.length - 1] !== pid) { ignored++; return; }
      for (const part of line.slice("Program data: ".length).split(" ")) {
        const ev = decodeEventData(Buffer.from(part, "base64"));
        if (ev) events.push({ ...ev, logIndex: i });
      }
    }
  });
  if (truncated && (opts.onTruncated ?? "throw") === "throw") throw new TruncatedLogsError();
  return { events, truncated, ignored };
}
