// CountyRoot leaf/tree format v2 (spec: docs/leaf-v2.md; mirrored in verifier/cr-verify.js).
//
//   key(id)   = normalized parcel ID: ASCII upper-case, without spaces/tabs, '.', '-', and leading zeros (keep one char)
//   leaf      = sha256(0x00 || "countyroot/leaf/v2" || u32le fips || u16le len(id) || id || u32le occ
//                      || u64le acres_micro || u64le sqft_centi)
//   node      = sha256(0x01 || left || right); the last node of an odd level is promoted unchanged (no duplication)
//   root      = sha256(0x02 || "countyroot/root/v2" || u32le fips || u32le epoch || u64le n_leaves || top)
//   order     = leaves sorted by (key bytes, id bytes, occ); occ numbers rows that share the exact same id, in
//               (acres_micro, sqft_centi) order, so CSV order never matters.
//   numbers   = decimal strings converted exactly (no floats), rounded half-up: acres to micro-acres, lot size to
//               centi-square-feet. u64::MAX means "not provided".
// The posted CountyRoot account keeps its layout (version byte 1); v2 is signalled by schema = SCHEMA_V2.
import { createHash } from "crypto";

const sha256 = (...parts: Buffer[]) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };

export const LEAF_VERSION_V2 = 2;
export const LEAF_TAG_V2 = Buffer.from("countyroot/leaf/v2", "ascii");
export const ROOT_TAG_V2 = Buffer.from("countyroot/root/v2", "ascii");
/** The v1 schema hash posted on-chain today: sha256("sha256(utf8 parcel_id|acres_6dp|lot_sqft_2dp)"). */
export const SCHEMA_V1 = sha256(Buffer.from("sha256(utf8 parcel_id|acres_6dp|lot_sqft_2dp)", "utf8"));
/** The v2 schema hash: sha256 of the v2 spec identifier. Posted in the existing `schema` field. */
export const SCHEMA_V2_ID = "countyroot/leaf/v2: sha256(0x00|tag|fips|len|id|occ|acres_micro|sqft_centi); node 0x01 promote-odd; root 0x02|tag|fips|epoch|n|top; sorted by key,id,occ";
export const SCHEMA_V2 = sha256(Buffer.from(SCHEMA_V2_ID, "utf8"));
export const NOT_PROVIDED = 0xffffffffffffffffn;

/** Parcel IDs in v2 are printable ASCII without leading/trailing spaces; the builder refuses anything else. */
export function checkIdV2(id: string): void {
  if (typeof id !== "string" || !id.length || id.length > 256) throw new Error(`bad parcel id length: ${JSON.stringify(id)}`);
  if (!/^[\x20-\x7e]+$/.test(id)) throw new Error(`parcel id is not printable ASCII: ${JSON.stringify(id)}`);
  if (id !== id.trim()) throw new Error(`parcel id has leading/trailing spaces: ${JSON.stringify(id)}`);
}
/** Normalized key (same rule as the live verifier's normKey, restricted to ASCII). */
export function keyV2(id: string): string {
  const up = id.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  const s = up.replace(/[ \t.\-]+/g, "").replace(/^0+(?=.)/, "");
  return s || up;
}
/** Exact decimal string -> integer units (10^dp), rounded half-up. Empty string -> NOT_PROVIDED. No floats. */
export function toUnits(value: string, dp: number): bigint {
  const s = String(value).trim();
  if (s === "") return NOT_PROVIDED;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`not a non-negative decimal: ${JSON.stringify(value)}`);
  const frac = m[2] ?? "";
  let v = BigInt((m[1] || "0") + frac.padEnd(dp, "0").slice(0, dp));
  if ((frac[dp] ?? "0") >= "5") v += 1n;
  if (v >= NOT_PROVIDED) throw new Error(`value too large: ${value}`);
  return v;
}
export function unitsToDecimal(v: bigint, dp: number): string {
  if (v === NOT_PROVIDED) return "";
  const s = v.toString().padStart(dp + 1, "0");
  return dp ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s;
}

export interface RowV2 { id: string; occ: number; acresMicro: bigint; sqftCenti: bigint; }

export function leafPreimageV2(fips: number, r: RowV2): Buffer {
  checkIdV2(r.id);
  const id = Buffer.from(r.id, "ascii");
  const b = Buffer.alloc(1 + LEAF_TAG_V2.length + 4 + 2 + id.length + 4 + 8 + 8);
  let o = 0;
  b[o++] = 0x00; LEAF_TAG_V2.copy(b, o); o += LEAF_TAG_V2.length;
  b.writeUInt32LE(fips, o); o += 4; b.writeUInt16LE(id.length, o); o += 2; id.copy(b, o); o += id.length;
  b.writeUInt32LE(r.occ, o); o += 4; b.writeBigUInt64LE(r.acresMicro, o); o += 8; b.writeBigUInt64LE(r.sqftCenti, o);
  return b;
}
export const leafHashV2 = (fips: number, r: RowV2) => sha256(leafPreimageV2(fips, r));
export const nodeHashV2 = (l: Buffer, r: Buffer) => sha256(Buffer.from([0x01]), l, r);
export function rootHashV2(fips: number, epoch: number, nLeaves: number, top: Buffer): Buffer {
  const h = Buffer.alloc(16); h.writeUInt32LE(fips, 0); h.writeUInt32LE(epoch, 4); h.writeBigUInt64LE(BigInt(nLeaves), 8);
  return sha256(Buffer.from([0x02]), ROOT_TAG_V2, h, top);
}

const cmpBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
export function compareRowsV2(a: RowV2, b: RowV2): number {
  return cmpBytes(keyV2(a.id), keyV2(b.id)) || cmpBytes(a.id, b.id) || a.occ - b.occ;
}

/** Packet rows (decimal strings) -> canonical v2 rows: integer units, occ assigned, sorted. Order-independent. */
export function canonicalRowsV2(rows: { parcel_id: string; acres: string; lot_sqft: string }[]): RowV2[] {
  const out = rows.map((r) => ({ id: r.parcel_id.trim(), occ: 0, acresMicro: toUnits(r.acres, 6), sqftCenti: toUnits(r.lot_sqft, 2) }));
  out.forEach((r) => checkIdV2(r.id));
  out.sort((a, b) => cmpBytes(keyV2(a.id), keyV2(b.id)) || cmpBytes(a.id, b.id)
    || (a.acresMicro < b.acresMicro ? -1 : a.acresMicro > b.acresMicro ? 1 : 0)
    || (a.sqftCenti < b.sqftCenti ? -1 : a.sqftCenti > b.sqftCenti ? 1 : 0));
  for (let i = 1; i < out.length; i++) if (out[i].id === out[i - 1].id) out[i].occ = out[i - 1].occ + 1;
  return out;
}

/** Every level, promote-odd rule. */
export function buildLevelsV2(leaves: Buffer[]): Buffer[][] {
  if (!leaves.length) throw new Error("no leaves");
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const lv = levels[levels.length - 1], nx: Buffer[] = [];
    for (let i = 0; i < lv.length; i += 2) nx.push(i + 1 < lv.length ? nodeHashV2(lv[i], lv[i + 1]) : lv[i]);
    levels.push(nx);
  }
  return levels;
}

export interface TreeV2 { fips: number; epoch: number; rows: RowV2[]; levels: Buffer[][]; top: Buffer; root: Buffer; }
export function buildTreeV2(fips: number, epoch: number, rows: RowV2[]): TreeV2 {
  for (let i = 1; i < rows.length; i++) if (compareRowsV2(rows[i - 1], rows[i]) >= 0) throw new Error(`rows not strictly sorted at ${i}`);
  const levels = buildLevelsV2(rows.map((r) => leafHashV2(fips, r)));
  const top = levels[levels.length - 1][0];
  return { fips, epoch, rows, levels, top, root: rootHashV2(fips, epoch, rows.length, top) };
}

export interface ProofV2 { version: 2; fips: number; epoch: number; nLeaves: number; index: number; row: { id: string; occ: number; acres_micro: string; sqft_centi: string }; siblings: string[]; }

/** Siblings for leaf `index`: one per level where the node has a partner (none where it is promoted). */
export function makeProofV2(t: TreeV2, index: number): ProofV2 {
  if (!Number.isInteger(index) || index < 0 || index >= t.rows.length) throw new Error("index out of range");
  const siblings: string[] = []; let i = index;
  for (let d = 0; d < t.levels.length - 1; d++) {
    const lv = t.levels[d];
    if (!(i === lv.length - 1 && lv.length % 2 === 1)) siblings.push(lv[i ^ 1].toString("hex"));
    i >>= 1;
  }
  const r = t.rows[index];
  return { version: 2, fips: t.fips, epoch: t.epoch, nLeaves: t.rows.length, index, siblings,
           row: { id: r.id, occ: r.occ, acres_micro: r.acresMicro.toString(), sqft_centi: r.sqftCenti.toString() } };
}

/** Recompute the leaf from the row, fold with the promote rule, bind fips/epoch/n, compare with `root`. */
export function verifyProofV2(p: ProofV2, root: Buffer | string): boolean {
  try {
    const want = typeof root === "string" ? Buffer.from(root, "hex") : root;
    if (p.version !== 2 || !Number.isInteger(p.index) || p.index < 0 || p.index >= p.nLeaves) return false;
    let node = leafHashV2(p.fips, { id: p.row.id, occ: p.row.occ, acresMicro: BigInt(p.row.acres_micro), sqftCenti: BigInt(p.row.sqft_centi) });
    let i = p.index, n = p.nLeaves, s = 0;
    while (n > 1) {
      if (!(i === n - 1 && n % 2 === 1)) {
        const sib = Buffer.from(p.siblings[s++] ?? "", "hex");
        if (sib.length !== 32) return false;
        node = i % 2 ? nodeHashV2(sib, node) : nodeHashV2(node, sib);
      }
      i >>= 1; n = Math.ceil(n / 2);
    }
    if (s !== p.siblings.length) return false;
    return rootHashV2(p.fips, p.epoch, p.nLeaves, node).equals(want);
  } catch { return false; }
}

/** Non-membership of a normalized key: the two adjacent leaves around it (either may be absent at the ends). */
export interface AbsenceProofV2 { version: 2; query: string; key: string; left: ProofV2 | null; right: ProofV2 | null; }
export function findKeyV2(t: TreeV2, query: string): { lo: number; hi: number } {
  const k = keyV2(query); let lo = 0, hi = t.rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cmpBytes(keyV2(t.rows[m].id), k) < 0) lo = m + 1; else hi = m; }
  let end = lo; while (end < t.rows.length && keyV2(t.rows[end].id) === k) end++;
  return { lo, hi: end }; // rows [lo, hi) have this key; lo is the insertion point when none do
}
export function makeAbsenceProofV2(t: TreeV2, query: string): AbsenceProofV2 {
  const { lo, hi } = findKeyV2(t, query);
  if (hi > lo) throw new Error(`${query} is present (${hi - lo} row(s)); no absence proof`);
  return { version: 2, query, key: keyV2(query), left: lo > 0 ? makeProofV2(t, lo - 1) : null, right: lo < t.rows.length ? makeProofV2(t, lo) : null };
}
export function verifyAbsenceV2(a: AbsenceProofV2, root: Buffer | string, fips: number, epoch: number): boolean {
  const k = keyV2(a.query);
  if (k !== a.key || (!a.left && !a.right)) return false;
  for (const p of [a.left, a.right]) if (p && (p.fips !== fips || p.epoch !== epoch || !verifyProofV2(p, root))) return false;
  const n = (a.left ?? a.right)!.nLeaves;
  if (a.left && a.right && (a.left.nLeaves !== a.right.nLeaves || a.right.index !== a.left.index + 1)) return false;
  if (!a.left && a.right!.index !== 0) return false;
  if (!a.right && a.left!.index !== n - 1) return false;
  if (a.left && !(cmpBytes(keyV2(a.left.row.id), k) < 0)) return false;
  if (a.right && !(cmpBytes(keyV2(a.right.row.id), k) > 0)) return false;
  return true;
}

/** v2 packet CSV: one row per leaf, in leaf order, integer columns; `leaf` = hex leaf hash (checked on read). */
export const CSV_HEADER_V2 = "parcel_id,occ,acres_micro,sqft_centi,leaf";
const csvField = (s: string) => (s.includes(",") || s.includes("\n") || s.startsWith('"') ? `"${s.replace(/"/g, '""')}"` : s);
export function packetCsvV2(t: TreeV2): string {
  const out: string[] = [CSV_HEADER_V2];
  t.rows.forEach((r, i) => out.push(`${csvField(r.id)},${r.occ},${r.acresMicro},${r.sqftCenti},${t.levels[0][i].toString("hex")}`));
  return out.join("\n") + "\n";
}
function splitCsvV2(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === "") q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
const uint = (s: string, what: string, line: number): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(s)) throw new Error(`line ${line}: ${what} is not a canonical non-negative integer: ${JSON.stringify(s)}`);
  return BigInt(s);
};
export function isPacketCsvV2(text: string): boolean { return text.slice(0, CSV_HEADER_V2.length + 2).replace(/\r/g, "").startsWith(CSV_HEADER_V2 + "\n"); }
/** Parse a v2 packet CSV (strict: exact header, canonical integers). Returns rows and the stored leaf column. */
export function parsePacketCsvV2(text: string): { rows: RowV2[]; leaves: string[] } {
  const lines = text.split("\n"); if (lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== CSV_HEADER_V2) throw new Error(`not a v2 packet CSV (header must be ${CSV_HEADER_V2})`);
  const rows: RowV2[] = [], leaves: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvV2(lines[i]);
    if (c.length !== 5) throw new Error(`line ${i + 1}: expected 5 columns, got ${c.length}`);
    const occ = uint(c[1], "occ", i + 1);
    if (occ > 0xffffffffn) throw new Error(`line ${i + 1}: occ too large`);
    const am = uint(c[2], "acres_micro", i + 1), sc = uint(c[3], "sqft_centi", i + 1);
    if (am > NOT_PROVIDED || sc > NOT_PROVIDED) throw new Error(`line ${i + 1}: value exceeds u64`);
    if (!/^[0-9a-f]{64}$/.test(c[4])) throw new Error(`line ${i + 1}: leaf must be 64 lowercase hex`);
    rows.push({ id: c[0], occ: Number(occ), acresMicro: am, sqftCenti: sc }); leaves.push(c[4]);
  }
  if (!rows.length) throw new Error("v2 packet CSV has no rows");
  return { rows, leaves };
}
/** Rebuild the v2 tree from a v2 packet CSV: rows must be in leaf order with correct occ, and every stored leaf must match. */
export function treeFromCsvV2(fips: number, epoch: number, text: string): TreeV2 {
  const { rows, leaves } = parsePacketCsvV2(text);
  for (let i = 0; i < rows.length; i++) {
    const want = i > 0 && rows[i - 1].id === rows[i].id ? rows[i - 1].occ + 1 : 0;
    if (rows[i].occ !== want) throw new Error(`line ${i + 2}: occ ${rows[i].occ} should be ${want}`);
    if (i > 0 && rows[i - 1].id === rows[i].id && (rows[i - 1].acresMicro > rows[i].acresMicro || (rows[i - 1].acresMicro === rows[i].acresMicro && rows[i - 1].sqftCenti > rows[i].sqftCenti)))
      throw new Error(`line ${i + 2}: repeated id not ordered by (acres, sqft)`);
  }
  const t = buildTreeV2(fips, epoch, rows); // refuses unsorted rows
  t.levels[0].forEach((h, i) => { if (h.toString("hex") !== leaves[i]) throw new Error(`line ${i + 2}: stored leaf does not match the recomputed leaf`); });
  return t;
}
