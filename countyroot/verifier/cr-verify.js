// CountyRoot parcel verifier core. Plain ES module, no dependencies: runs in browsers (WebCrypto) and in Node >= 19.
// It re-implements the SDK's v1 leaf and tree rules (countyroot/sdk/src/merkle.ts) byte for byte:
//   leaf   = sha256(utf8(parcel_id + "|" + acres(6dp, half-up) + "|" + lot_sqft(2dp, half-up)))
//   parent = sha256(left || right), leaves in packet (CSV) order, an odd level duplicates its last node.
// Proof sidecar layout (written by scripts/build_proofs.mjs), relative to <packet base>.proofs/:
//   index.json        layout only (chunk size, shard count). Untrusted: every value that matters is re-checked.
//   s/<k>.json        rows whose lookup key hashes to shard k: [[parcel_id, acres, lot_sqft, leaf_index], ...]
//   c/<k>.bin         leaf hashes k*chunk .. (k+1)*chunk-1, 32 bytes each
//   top.bin           every tree level from the chunk-root level up to the root, 32 bytes per node
// Nothing in these files is trusted. A proof only passes if the recomputed root equals the on-chain root
// (or, if the RPC is unreachable, the root published in the site's counties.json).

export const PROOF_FORMAT = 1;
export const PROGRAM_ID = "7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg";
export const STATUS_ACTIVE = 1;
export const STATUS_RETRACTED = 2;

const enc = new TextEncoder();
const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error("WebCrypto is not available (the page must be served over https or from localhost)");
  return s;
};
export async function sha256(bytes) { return new Uint8Array(await subtle().digest("SHA-256", bytes)); }

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(h) {
  if (typeof h !== "string" || !/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
export const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

/** Same as the SDK's formatFixed: round a decimal string half-up to dp places. */
export function formatFixed(value, dp) {
  let s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value).trim();
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
export const leafPreimage = (id, acres, sqft) => `${id}|${formatFixed(acres, 6)}|${formatFixed(sqft, 2)}`;
export const leafHash = (id, acres, sqft) => sha256(enc.encode(leafPreimage(id, acres, sqft)));
export const hashPair = (l, r) => sha256(concat(l, r));

/** Lookup key for a parcel ID: trimmed and upper-cased, so the search is case-insensitive. */
export const lookupKey = (id) => String(id).trim().toUpperCase();
/** Shard number for a parcel ID: first 4 bytes of sha256(utf8(lookupKey)) as a big-endian u32, mod nShards. */
export async function shardOf(id, nShards) {
  const h = await sha256(enc.encode(lookupKey(id)));
  return (((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3]) % nShards;
}

/** Tree depth for n leaves (number of sibling hashes in a proof). */
export function depthOf(n) { let d = 0; for (let k = n; k > 1; k = Math.ceil(k / 2)) d++; return d; }

/** Split top.bin into levels: level 0 has nChunks nodes, each next level ceil(len/2), up to 1 node. */
export function splitTop(bytes, nChunks) {
  const levels = []; let off = 0;
  for (let len = nChunks; ; len = Math.ceil(len / 2)) {
    if (off + len * 32 > bytes.length) throw new Error("top.bin is too short");
    const lv = []; for (let i = 0; i < len; i++) lv.push(bytes.subarray(off + i * 32, off + i * 32 + 32));
    levels.push(lv); off += len * 32;
    if (len === 1) break;
  }
  if (off !== bytes.length) throw new Error("top.bin has trailing bytes");
  return levels;
}

/** All levels of a (sub)tree, SDK rule; each level is hashed in parallel. */
export async function buildLevels(leaves) {
  if (!leaves.length) throw new Error("no leaves");
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const lv = levels[levels.length - 1], jobs = [];
    for (let j = 0; j < lv.length; j += 2) jobs.push(hashPair(lv[j], lv[j + 1] ?? lv[j]));
    levels.push(await Promise.all(jobs));
  }
  return levels;
}
const LEVELS = new WeakMap();

/**
 * Build an SDK-format proof { leaf, index, siblings[], leafCount } for leaf `index`, from its chunk file and top.bin.
 * `leaf` is the leaf the caller recomputed from the row (it replaces the chunk's copy, so a tampered chunk can't help).
 */
export async function assembleProof({ leaf, index, nLeaves, chunkSize, chunkBytes, topBytes }) {
  if (chunkSize < 2 || (chunkSize & (chunkSize - 1))) throw new Error("chunk size must be a power of two");
  if (!Number.isInteger(index) || index < 0 || index >= nLeaves) throw new Error("leaf index out of range");
  const nChunks = Math.ceil(nLeaves / chunkSize), k = Math.floor(index / chunkSize);
  const inChunk = Math.min(chunkSize, nLeaves - k * chunkSize);
  if (chunkBytes.length !== inChunk * 32) throw new Error(`chunk ${k} should hold ${inChunk} leaves`);
  const leaves = []; for (let i = 0; i < inChunk; i++) leaves.push(chunkBytes.subarray(i * 32, i * 32 + 32));
  let i = index - k * chunkSize;
  // Fast path: the row's leaf equals the chunk's copy, so the chunk's levels (cached per chunk) are the real ones.
  // Otherwise rebuild the chunk with our recomputed leaf in place (a tampered row or chunk then fails at the root).
  let levels;
  if (eq(leaves[i], leaf)) {
    if (!LEVELS.has(chunkBytes)) LEVELS.set(chunkBytes, buildLevels(leaves));
    levels = await LEVELS.get(chunkBytes);
  } else { const l2 = leaves.slice(); l2[i] = leaf; levels = await buildLevels(l2); }
  const siblings = [];
  for (let d = 0; d < levels.length - 1; d++) { const lv = levels[d]; siblings.push(lv[i ^ 1] ?? lv[i]); i >>= 1; }
  let lv = levels[levels.length - 1];
  let node = lv[0];
  // A short last chunk stops early; in the full tree its root keeps pairing with itself up to the chunk-root level.
  const chunkDepth = nChunks > 1 ? Math.log2(chunkSize) : depthOf(nLeaves);
  while (siblings.length < chunkDepth) { siblings.push(node); node = await hashPair(node, node); }
  // Above the chunks: siblings come from top.bin (the level-0 entry for this chunk is replaced by our own value).
  const top = splitTop(topBytes, nChunks);
  top[0] = top[0].slice(); top[0][k] = node;
  let j = k;
  for (let d = 0; d < top.length - 1; d++) {
    const level = top[d];
    siblings.push(j % 2 ? level[j - 1] : level[j + 1] ?? level[j]);
    j >>= 1;
  }
  return { leaf: toHex(leaf), index, siblings: siblings.map(toHex), leafCount: nLeaves };
}

/** Port of the SDK's verifyProof: fold the proof to a root and compare. Returns the computed root hex too. */
export async function verifyProof(proof, rootHex) {
  const fail = (why) => ({ ok: false, why, computed: null });
  if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= proof.leafCount) return fail("index out of range");
  if (proof.siblings.length !== depthOf(proof.leafCount)) return fail("proof length does not match the parcel count");
  let node = fromHex(proof.leaf), i = proof.index, n = proof.leafCount;
  for (const s of proof.siblings) {
    const sib = fromHex(s);
    if (sib.length !== 32) return fail("bad sibling");
    if (i % 2 === 0 && i === n - 1 && !eq(sib, node)) return fail("odd-node rule violated");
    node = i % 2 ? await hashPair(sib, node) : await hashPair(node, sib);
    i >>= 1; n = Math.ceil(n / 2);
  }
  const computed = toHex(node);
  return { ok: node.length === 32 && computed === String(rootHex).toLowerCase(), why: "root mismatch", computed };
}

// ---------- on-chain account ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = "1" + s; }
  return s;
}
export function b64decode(s) {
  if (typeof atob === "function") { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < o.length; i++) o[i] = bin.charCodeAt(i); return o; }
  return new Uint8Array(Buffer.from(s, "base64"));
}
let DISC;
export async function countyRootDiscriminator() { return (DISC ??= (await sha256(enc.encode("account:CountyRoot"))).slice(0, 8)); }

/** Decode CountyRoot account bytes (same layout as the SDK's decodeCountyRoot; v0 = 98 bytes, v1 = 99 with a version byte). */
export async function decodeCountyRoot(data) {
  if (data.length < 98) throw new Error("account is too short to be a CountyRoot");
  if (!eq(data.subarray(0, 8), await countyRootDiscriminator())) throw new Error("account is not a CountyRoot");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    fips: dv.getUint32(8, true), epoch: dv.getUint32(12, true), nParcels: dv.getBigUint64(16, true),
    merkleRoot: toHex(data.subarray(24, 56)), schema: toHex(data.subarray(56, 88)), status: data[88],
    postedAt: Number(dv.getBigInt64(89, true)), bump: data[97], version: data.length > 98 ? data[98] : 0,
  };
}

/**
 * Read a CountyRoot PDA with getAccountInfo (finalized). Throws on network/RPC errors so the caller can fall back.
 * Checks the owner is the CountyRoot program and the discriminator. The caller checks fips/epoch/root/status.
 * The browser can't derive the PDA itself without an ed25519 library, but it doesn't need to: only the CountyRoot
 * program can write an account it owns with this discriminator, and post_root writes fips/epoch from the same values
 * it uses as seeds, so an owned CountyRoot whose fips/epoch match is the canonical one.
 */
export async function fetchCountyRoot(rpcUrl, pda, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl?.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64", commitment: "finalized" }] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`RPC error: ${j.error.message ?? JSON.stringify(j.error)}`);
    const v = j.result && j.result.value;
    if (!v) return null;
    if (v.owner !== PROGRAM_ID) throw new Error(`account ${pda} is not owned by CountyRoot (owner ${v.owner})`);
    return { ...(await decodeCountyRoot(b64decode(v.data[0]))), slot: j.result.context?.slot };
  } finally { if (t) clearTimeout(t); }
}

/**
 * Full check for one parcel ID. `load(path)` fetches a file under the proofs base and returns
 * { json } for .json or { bytes } for .bin; it should throw { notFound: true } on 404.
 * `county` comes from the site's counties.json (label, fips, epoch, n_parcels, merkle_root, pda).
 * `onchain(county)` returns the decoded account, null (missing), or throws (unreachable).
 * Returns { found, rows: [{ row, parcel_id, acres, lot_sqft, index, leaf, ok, computed, reason }], anchor }.
 */
export async function verifyParcel({ county, parcelId, load, onchain }) {
  const index = await load("index.json").then((r) => r.json);
  if (index.format !== PROOF_FORMAT) throw new Error(`unsupported proof format ${index.format}`);
  if (index.fips !== county.fips || index.epoch !== county.epoch) throw new Error("proof files are for a different county or epoch");
  const key = lookupKey(parcelId);
  if (!key) throw new Error("enter a parcel ID");

  // Which root do we compare against? On-chain first; the published fingerprint only if the RPC is unreachable.
  let anchor;
  try {
    const acct = await onchain(county);
    if (!acct) anchor = { kind: "onchain-missing", ok: false, note: "no on-chain account at this address" };
    else {
      const probs = [];
      if (acct.fips !== county.fips || acct.epoch !== county.epoch) probs.push(`on-chain account is fips ${acct.fips} epoch ${acct.epoch}`);
      if (acct.status !== STATUS_ACTIVE) probs.push(acct.status === STATUS_RETRACTED ? "this epoch is RETRACTED on-chain" : `on-chain status ${acct.status}`);
      if (acct.merkleRoot !== county.merkle_root) probs.push("on-chain root differs from the published fingerprint (the on-chain root is used)");
      anchor = { kind: "onchain", ok: probs.filter((p) => !p.startsWith("on-chain root differs")).length === 0, root: acct.merkleRoot,
                 nParcels: Number(acct.nParcels), status: acct.status, postedAt: acct.postedAt, version: acct.version, slot: acct.slot, problems: probs };
    }
  } catch (e) {
    anchor = { kind: "published", ok: true, root: county.merkle_root, nParcels: county.n_parcels, note: `on-chain check unavailable: ${e.message || e}` };
  }
  const root = anchor.root ?? county.merkle_root, nLeaves = anchor.nParcels ?? county.n_parcels;
  if (index.n_parcels !== nLeaves) throw new Error(`proof files cover ${index.n_parcels} parcels but the root covers ${nLeaves}`);

  const shard = await shardOf(key, index.n_shards);
  const rowsAll = (await load(`s/${shard}.json`)).json.rows;
  const hits = rowsAll.filter((r) => lookupKey(r[0]) === key);
  if (!hits.length) return { found: false, rows: [], anchor };

  const chunkCache = new Map();
  const getChunk = (k) => { if (!chunkCache.has(k)) chunkCache.set(k, load(`c/${k}.bin`).then((r) => r.bytes)); return chunkCache.get(k); };
  const top = (await load("top.bin")).bytes;
  const out = [];
  for (const [pid, acres, sqft, idx] of hits) {
    const r = { row: idx + 2, parcel_id: pid, acres, lot_sqft: sqft, index: idx };
    try {
      if (!Number.isInteger(idx) || idx < 0 || idx >= nLeaves) throw new Error("row index out of range");
      const leaf = await leafHash(pid, acres, sqft);
      r.leaf = toHex(leaf);
      const proof = await assembleProof({ leaf, index: idx, nLeaves, chunkSize: index.chunk_size, chunkBytes: await getChunk(Math.floor(idx / index.chunk_size)), topBytes: top });
      const v = await verifyProof(proof, root);
      r.ok = v.ok && anchor.ok; r.proofOk = v.ok; r.computed = v.computed; r.proof = proof;
      r.reason = v.ok ? (anchor.ok ? "" : "proof matches, but the on-chain root is not active") : "the row's fingerprint path does not lead to the root (data changed or wrong row)";
    } catch (e) { r.ok = false; r.reason = e.message || String(e); }
    out.push(r);
  }
  return { found: true, rows: out, anchor };
}
