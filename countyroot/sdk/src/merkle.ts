import { createHash } from "crypto";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** Round a decimal string/number half-up to `dp` places, as the packet builder does (Python Decimal ROUND_HALF_UP). */
export function formatFixed(value: string | number, dp: number): string {
  let s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  if (/e/i.test(s)) s = Number(s).toFixed(20);
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`not a decimal number: ${value}`);
  const neg = m[1] === "-", int = m[2] || "0", frac = m[3] ?? "";
  let digits = BigInt(int + frac.padEnd(dp, "0").slice(0, dp));
  if ((frac[dp] ?? "0") >= "5") digits += 1n;
  let out = digits.toString().padStart(dp + 1, "0");
  out = dp ? `${out.slice(0, -dp)}.${out.slice(-dp)}` : out;
  return neg && digits !== 0n ? `-${out}` : out;
}

/** The leaf string: utf8(parcel_id) + "|" + acres(6dp) + "|" + lot_sqft(2dp). */
export function leafPreimage(parcelId: string, acres: string | number, lotSqft: string | number): string {
  return `${parcelId}|${formatFixed(acres, 6)}|${formatFixed(lotSqft, 2)}`;
}
export function leafHash(parcelId: string, acres: string | number, lotSqft: string | number): Buffer {
  return sha256(Buffer.from(leafPreimage(parcelId, acres, lotSqft), "utf8"));
}

/** Parent = sha256(left || right). No sorting; position matters. */
export const hashPair = (l: Buffer, r: Buffer) => sha256(Buffer.concat([l, r]));

/** Build every level. Leaves are in packet (CSV) order; an odd level duplicates its last node. */
export function buildLevels(leaves: Buffer[]): Buffer[][] {
  if (!leaves.length) throw new Error("no leaves");
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const lv = levels[levels.length - 1], nx: Buffer[] = [];
    for (let i = 0; i < lv.length; i += 2) nx.push(hashPair(lv[i], lv[i + 1] ?? lv[i]));
    levels.push(nx);
  }
  return levels;
}
export const merkleRoot = (leaves: Buffer[]) => { const l = buildLevels(leaves); return l[l.length - 1][0]; };

export interface Proof { leaf: string; index: number; siblings: string[]; leafCount: number; }

export function makeProof(levels: Buffer[][], index: number): Proof {
  if (index < 0 || index >= levels[0].length) throw new Error("index out of range");
  const siblings: string[] = [];
  let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const lv = levels[d];
    siblings.push((i % 2 ? lv[i - 1] : lv[i + 1] ?? lv[i]).toString("hex"));
    i >>= 1;
  }
  return { leaf: levels[0][index].toString("hex"), index, siblings, leafCount: levels[0].length };
}

/** Fold the proof up to a root; returns true if it equals `root`. Checks the proof length against leafCount. */
export function verifyProof(proof: Proof, root: Buffer | string): boolean {
  const want = typeof root === "string" ? Buffer.from(root, "hex") : root;
  if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= proof.leafCount) return false;
  let depth = 0; for (let n = proof.leafCount; n > 1; n = Math.ceil(n / 2)) depth++;
  if (proof.siblings.length !== depth) return false;
  let node = Buffer.from(proof.leaf, "hex"), i = proof.index, n = proof.leafCount;
  for (const s of proof.siblings) {
    const sib = Buffer.from(s, "hex");
    if (sib.length !== 32) return false;
    // the last node of an odd level must be paired with itself
    if (i % 2 === 0 && i === n - 1 && !sib.equals(node)) return false;
    node = i % 2 ? hashPair(sib, node) : hashPair(node, sib);
    i >>= 1; n = Math.ceil(n / 2);
  }
  return node.length === 32 && node.equals(want);
}

export interface PacketRow { parcel_id: string; acres: string; lot_sqft: string; leaf?: string; }

/** Parse a packet CSV (parcel_id,acres,lot_sqft,leaf). Parcel IDs in packets contain no commas or quotes except where quoted. */
export function parsePacketCsv(text: string): PacketRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = splitCsv(lines[0]);
  const idx = (k: string) => { const i = header.indexOf(k); if (i < 0) throw new Error(`packet CSV missing ${k}`); return i; };
  const [p, a, s] = [idx("parcel_id"), idx("acres"), idx("lot_sqft")], l = header.indexOf("leaf");
  return lines.slice(1).map((line) => { const c = splitCsv(line); return { parcel_id: c[p], acres: c[a], lot_sqft: c[s], leaf: l >= 0 ? c[l] : undefined }; });
}
function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    // A quote only opens a quoted field at the start of the field (like Python's csv module);
    // elsewhere it is a literal character, e.g. parcel_id LOT "A".
    else if (ch === '"' && cur === "") q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}

/** Recompute every leaf from the row fields (and compare with the stored leaf column, if present). */
export function packetLeaves(rows: PacketRow[]): Buffer[] {
  return rows.map((r, i) => {
    const h = leafHash(r.parcel_id, r.acres, r.lot_sqft);
    if (r.leaf && r.leaf.toLowerCase() !== h.toString("hex")) throw new Error(`row ${i + 1}: stored leaf does not match recomputed leaf`);
    return h;
  });
}
