// Vendored from countyroot/verifier/cr-verify.js (same code that runs at countyroot.com/verify). Keep in sync.
// @ts-nocheck
// CountyRoot parcel verifier core. Plain ES module, no dependencies: runs in browsers (WebCrypto) and in Node >= 19.
// It re-implements the SDK's v1 leaf and tree rules (countyroot/sdk/src/merkle.ts) byte for byte:
//   leaf   = sha256(utf8(parcel_id + "|" + acres(6dp, half-up) + "|" + lot_sqft(2dp, half-up)))
//   parent = sha256(left || right), leaves in packet (CSV) order, an odd level duplicates its last node.
// Proof sidecar layout (written by scripts/build_proofs.mjs), relative to <packet base>.proofs/:
//   index.json        layout only (chunk size, shard count). Untrusted: every value that matters is re-checked.
//   s/<k>.json        rows whose lookup key hashes to shard k: [[parcel_id, acres, lot_sqft, leaf_index], ...]
//   c/<k>.bin         leaf hashes k*chunk .. (k+1)*chunk-1, 32 bytes each
//   top.bin           every tree level from the chunk-root level up to the root, 32 bytes per node
//   x/<k>.json        lookup aliases, keyed by normKey(term): {entries: {term: [[parcel_id, type], ...]}}
//                     type 0 = the parcel ID written differently (dashes/spaces/dots/leading zeros/case);
//                     type >= 1 = index.alias_types[type - 1], e.g. a county's own Property ID. Optional.
//   p/index.json      prefix buckets for "did you mean" suggestions: {len, keys: [...]}; p/<hex(key)>.json = sorted IDs. Optional.
// Aliases and suggestions are only a way to FIND the parcel ID. They are not in the leaf or the on-chain root;
// the proof is always on the exact parcel ID from the packet.
// Nothing in these files is trusted. A proof only passes if the recomputed root equals the on-chain root
// (or, if the RPC is unreachable, the root published in the site's counties.json).

export const PROOF_FORMAT = 1;
export const PROGRAM_ID = "7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg";
export const STATUS_ACTIVE = 1;
export const STATUS_RETRACTED = 2;
export const STATUS_SUPERSEDED = 3;
/** "fetched 2026-10-14T20:07:44Z" or, when flags.fetched_at_is_upper_bound, "fetched no later than ...". null without provenance. */
export function fetchedAtText(acct) {
  if (!acct || !acct.fetchedAt) return null;
  const t = new Date(acct.fetchedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return acct.fetchedAtIsUpperBound ? `fetched no later than ${t}` : `fetched ${t}`;
}

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
/** Normalized key: lookupKey without spaces, dashes and dots, and without leading zeros ("0240-050.817" -> "240050817"). */
export function normKey(id) {
  const s = lookupKey(id).replace(/[\s.\-]+/g, "").replace(/^0+(?=.)/, "");
  return s || lookupKey(id);
}
const hexOf = (str) => toHex(enc.encode(str));
/** File name for a prefix bucket key. */
export const prefixFile = (key) => `p/${key === "" ? "_" : hexOf(key)}.json`;
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
    ...(data.length >= 256 && data[98] >= 2 ? {
      // v2 provenance tail (program 0.3): read by offset after the unchanged 98-byte body.
      manifestSha256: toHex(data.subarray(99, 131)), sourceSha256: toHex(data.subarray(131, 163)), packetSha256: toHex(data.subarray(163, 195)),
      dataAsOf: Number(dv.getBigInt64(195, true)), fetchedAt: Number(dv.getBigInt64(203, true)),
      statusChangedAt: Number(dv.getBigInt64(219, true)), supersededBy: dv.getUint32(227, true), retractReason: data[231],
      leafVersion: data[232], migrated: (data[233] & 1) === 1, fetchedAtIsUpperBound: (data[233] & 2) === 2,
    } : {}),
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


export const SCHEMA_V1_HEX = "1b0a0a99e80b71583619941720ccd746c9bd03551ca906bcb0a333839b29a427";
/** Which root do we compare against? On-chain first; the published fingerprint only if the RPC is unreachable. */
async function getAnchor(county, onchain, leafVersion) {
  let anchor;
  try {
    const acct = await onchain(county);
    if (!acct) anchor = { kind: "onchain-missing", ok: false, note: "no on-chain account at this address" };
    else {
      const probs = [];
      if (acct.fips !== county.fips || acct.epoch !== county.epoch) probs.push(`on-chain account is fips ${acct.fips} epoch ${acct.epoch}`);
      const warnings = [];
      // SUPERSEDED: still a valid historical proof, but not the county's current data.
      if (acct.status === STATUS_SUPERSEDED) warnings.push(`not the latest epoch: superseded by epoch ${acct.supersededBy || "?"}`);
      else if (acct.status !== STATUS_ACTIVE) probs.push(acct.status === STATUS_RETRACTED ? "this epoch is RETRACTED on-chain" : `on-chain status ${acct.status}`);
      // v2 roots carry schema = SCHEMA_V2; v1 proof files must never be checked against a v2 root or vice versa.
      if (leafVersion === 2 ? acct.schema !== SCHEMA_V2_HEX : acct.schema === SCHEMA_V2_HEX)
        probs.push(`the on-chain fingerprint format (schema ${acct.schema.slice(0, 12)}…) is not the v${leafVersion} format these proof files use`);
      if (acct.merkleRoot !== county.merkle_root) probs.push("on-chain root differs from the published fingerprint (the on-chain root is used)");
      anchor = { kind: "onchain", ok: probs.filter((p) => !p.startsWith("on-chain root differs")).length === 0, root: acct.merkleRoot,
                 nParcels: Number(acct.nParcels), status: acct.status, postedAt: acct.postedAt, version: acct.version, schema: acct.schema, slot: acct.slot, problems: probs,
                 current: acct.status === STATUS_ACTIVE, supersededBy: acct.status === STATUS_SUPERSEDED ? (acct.supersededBy || null) : null,
                 retractReason: acct.retractReason ?? null, manifestSha256: acct.manifestSha256 ?? null, warnings };
    }
  } catch (e) {
    anchor = { kind: "published", ok: true, root: county.merkle_root, nParcels: county.n_parcels, note: `on-chain check unavailable: ${e.message || e}` };
  }
  return anchor;
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
  if (index.format === 2) return verifyParcelV2({ county, parcelId, load, onchain, index });
  if (index.format !== PROOF_FORMAT) throw new Error(`unsupported proof format ${index.format}`);
  if (index.fips !== county.fips || index.epoch !== county.epoch) throw new Error("proof files are for a different county or epoch");
  const key = lookupKey(parcelId);
  if (!key) throw new Error("enter a parcel ID");

  const anchor = await getAnchor(county, onchain, 1);
  const root = anchor.root ?? county.merkle_root, nLeaves = anchor.nParcels ?? county.n_parcels;
  if (index.n_parcels !== nLeaves) throw new Error(`proof files cover ${index.n_parcels} parcels but the root covers ${nLeaves}`);

  const rowsFor = async (id) => {
    const k = lookupKey(id), rows = (await load(`s/${await shardOf(k, index.n_shards)}.json`)).json.rows;
    return rows.filter((r) => lookupKey(r[0]) === k);
  };
  // 1. exact parcel ID (case-insensitive)
  let hits = (await rowsFor(key)).map((r) => ({ r, via: null }));
  let resolution = { typed: parcelId.trim(), mode: hits.length ? "exact" : "none", matches: [] };
  if (!hits.length) {
    // 2. normalized form, then 3. the alias index (normalized IDs + county aliases such as a Property ID)
    const nk = normKey(parcelId), cands = new Map();
    if (nk !== key) for (const r of await rowsFor(nk)) cands.set(r[0], { id: r[0], via: "normalized" });
    if (index.n_xshards) {
      const x = (await load(`x/${await shardOf(nk, index.n_xshards)}.json`)).json.entries[nk] ?? [];
      for (const [id, t] of x) {
        const via = t === 0 ? "normalized" : (index.alias_types?.[t - 1]?.label ?? `alias ${t}`);
        if (!cands.has(id)) cands.set(id, { id, via, aliasType: t ? index.alias_types?.[t - 1] : null });
      }
    }
    for (const c of cands.values()) {
      const rs = await rowsFor(c.id);
      if (rs.length) resolution.matches.push(c);
      for (const r of rs) hits.push({ r, via: c });
    }
    resolution.mode = hits.length ? (resolution.matches.some((m) => m.via !== "normalized") ? "alias" : "normalized") : "none";
  }
  if (!hits.length) return { found: false, rows: [], anchor, resolution, suggestions: await suggest(index, parcelId, load).catch(() => []) };
  const chunkCache = new Map();
  const getChunk = (k) => { if (!chunkCache.has(k)) chunkCache.set(k, load(`c/${k}.bin`).then((r) => r.bytes)); return chunkCache.get(k); };
  const top = (await load("top.bin")).bytes;
  const out = [];
  for (const { r: [pid, acres, sqft, idx], via } of hits) {
    const r = { row: idx + 2, parcel_id: pid, acres, lot_sqft: sqft, index: idx, via: via ? via.via : null };
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
  return { found: true, rows: out, anchor, resolution };
}

/** Up to `max` parcel IDs whose normalized form starts with the normalized input (from the p/ prefix buckets). */
export async function suggest(index, input, load, max = 10) {
  if (!index.has_prefix) return [];
  const t = normKey(input);
  if (!t) return [];
  const p = (await load("p/index.json")).json;
  // Buckets that can hold IDs starting with t: keys that extend t, or keys that t extends (longest first).
  const longer = p.keys.filter((k) => k.startsWith(t)).sort();
  const shorter = p.keys.filter((k) => k.length < t.length && t.startsWith(k)).sort((a, b) => b.length - a.length);
  const keys = longer.length ? longer : shorter;
  const out = [];
  for (const k of keys.slice(0, 4)) {
    for (const id of (await load(prefixFile(k))).json.ids) { if (normKey(id).startsWith(t)) out.push(id); if (out.length >= max) return out; }
  }
  return out;
}

// ---------- leaf format v2 (spec: docs/leaf-v2.md, reference code: sdk/src/leafv2.ts) ----------
// Proof files, format 2, relative to <packet base>.proofs/:
//   index.json   { format: 2, leaf_version: 2, fips, epoch, n_leaves, chunk_size, n_chunks, schema, ... } (untrusted)
//   f.json       { fences: [keyV2(first row of chunk k), ...] }: leaves are sorted by key, so a lookup is a binary search
//   r/<k>.json   { rows: [[parcel_id, occ, acres_micro, sqft_centi], ...] } for leaves k*chunk .. in leaf order
//   c/<k>.bin    leaf hashes of chunk k; top.bin: chunk roots and every level above (promote-odd rule)
//   x/<k>.json   optional county aliases (as in format 1, type >= 1 only; normalized IDs need no index in v2)
export const SCHEMA_V2_HEX = "b309043c77b9aa529244033ecbcaa030615fa949993c835bade21fd2abfbf00d";
const LEAF_TAG_V2 = enc.encode("countyroot/leaf/v2"), ROOT_TAG_V2 = enc.encode("countyroot/root/v2");
export function keyV2(id) {
  const up = String(id).trim().replace(/[a-z]/g, (c) => c.toUpperCase());
  const s = up.replace(/[ \t.\-]+/g, "").replace(/^0+(?=.)/, "");
  return s || up;
}
/** Byte-order compare of ASCII strings (v2 IDs are printable ASCII, so code-unit order = byte order). */
export const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function unitsToDecimal(v, dp) {
  const s = BigInt(v).toString().padStart(dp + 1, "0");
  return dp ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s;
}
export async function leafHashV2(fips, id, occ, acresMicro, sqftCenti) {
  if (!/^[\x20-\x7e]{1,256}$/.test(id) || id !== id.trim()) throw new Error("parcel ID is not canonical printable ASCII");
  const idb = enc.encode(id), b = new Uint8Array(1 + LEAF_TAG_V2.length + 4 + 2 + idb.length + 4 + 16), dv = new DataView(b.buffer);
  let o = 0; b[o++] = 0; b.set(LEAF_TAG_V2, o); o += LEAF_TAG_V2.length;
  dv.setUint32(o, fips, true); o += 4; dv.setUint16(o, idb.length, true); o += 2; b.set(idb, o); o += idb.length;
  dv.setUint32(o, occ, true); o += 4; dv.setBigUint64(o, BigInt(acresMicro), true); o += 8; dv.setBigUint64(o, BigInt(sqftCenti), true);
  return sha256(b);
}
export const nodeHashV2 = (l, r) => { const b = new Uint8Array(65); b[0] = 1; b.set(l, 1); b.set(r, 33); return sha256(b); };
export async function rootHashV2(fips, epoch, n, top) {
  const b = new Uint8Array(1 + ROOT_TAG_V2.length + 16 + 32), dv = new DataView(b.buffer);
  b[0] = 2; b.set(ROOT_TAG_V2, 1); let o = 1 + ROOT_TAG_V2.length;
  dv.setUint32(o, fips, true); dv.setUint32(o + 4, epoch, true); dv.setBigUint64(o + 8, BigInt(n), true); b.set(top, o + 16);
  return sha256(b);
}
async function levelsV2(leaves) {
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const lv = levels[levels.length - 1], jobs = [];
    for (let j = 0; j < lv.length; j += 2) jobs.push(j + 1 < lv.length ? nodeHashV2(lv[j], lv[j + 1]) : Promise.resolve(lv[j]));
    levels.push(await Promise.all(jobs));
  }
  return levels;
}
/** Siblings for leaf `index` from its chunk (with our recomputed leaf in place) and top.bin; promote-odd rule. */
export async function assembleProofV2({ leaf, index, nLeaves, chunkSize, chunkBytes, topBytes }) {
  if (chunkSize < 2 || (chunkSize & (chunkSize - 1))) throw new Error("chunk size must be a power of two");
  if (!Number.isInteger(index) || index < 0 || index >= nLeaves) throw new Error("leaf index out of range");
  const nChunks = Math.ceil(nLeaves / chunkSize), k = Math.floor(index / chunkSize), inChunk = Math.min(chunkSize, nLeaves - k * chunkSize);
  if (chunkBytes.length !== inChunk * 32) throw new Error(`chunk ${k} should hold ${inChunk} leaves`);
  const leaves = []; for (let i = 0; i < inChunk; i++) leaves.push(chunkBytes.subarray(i * 32, i * 32 + 32));
  let i = index - k * chunkSize; leaves[i] = leaf;
  const siblings = [], levels = await levelsV2(leaves);
  for (let d = 0; d < levels.length - 1; d++) { const lv = levels[d]; if (!(i === lv.length - 1 && lv.length % 2 === 1)) siblings.push(lv[i ^ 1]); i >>= 1; }
  // A short last chunk's root is promoted unchanged up to the chunk-root level (it is the last, odd node there).
  const top = splitTop(topBytes, nChunks); top[0] = top[0].slice(); top[0][k] = levels[levels.length - 1][0];
  let j = k;
  for (let d = 0; d < top.length - 1; d++) { const lv = top[d]; if (!(j === lv.length - 1 && lv.length % 2 === 1)) siblings.push(lv[j ^ 1]); j >>= 1; }
  return { leaf: toHex(leaf), index, nLeaves, siblings: siblings.map(toHex) };
}
/** Fold a v2 proof from the recomputed leaf and bind fips/epoch/n into the root. */
export async function verifyProofV2({ fips, epoch, nLeaves, index, leaf, siblings }, rootHex) {
  const fail = (why) => ({ ok: false, why, computed: null });
  if (!Number.isInteger(index) || index < 0 || index >= nLeaves) return fail("index out of range");
  let node = fromHex(leaf), i = index, n = nLeaves, s = 0;
  while (n > 1) {
    if (!(i === n - 1 && n % 2 === 1)) {
      const sib = fromHex(siblings[s++] ?? "");
      if (sib.length !== 32) return fail("proof is too short");
      node = i % 2 ? await nodeHashV2(sib, node) : await nodeHashV2(node, sib);
    }
    i >>= 1; n = Math.ceil(n / 2);
  }
  if (s !== siblings.length) return fail("proof is too long");
  const computed = toHex(await rootHashV2(fips, epoch, nLeaves, node));
  return { ok: computed === String(rootHex).toLowerCase(), why: "root mismatch", computed };
}

/** v2 check: binary search by normalized key; found rows are proven, a missing key gets a non-membership proof. */
export async function verifyParcelV2({ county, parcelId, load, onchain, index }) {
  if (index.leaf_version !== 2 || index.schema !== SCHEMA_V2_HEX) throw new Error("unsupported v2 proof files");
  if (index.fips !== county.fips || index.epoch !== county.epoch) throw new Error("proof files are for a different county or epoch");
  const typed = String(parcelId).trim();
  if (!typed) throw new Error("enter a parcel ID");
  const anchor = await getAnchor(county, onchain, 2);
  const root = anchor.root ?? county.merkle_root, n = anchor.nParcels ?? county.n_parcels;
  if (index.n_leaves !== n) throw new Error(`proof files cover ${index.n_leaves} leaves but the root covers ${n}`);
  const C = index.chunk_size, nChunks = Math.ceil(n / C);
  if (index.n_chunks !== nChunks) throw new Error("proof files have the wrong chunk count");
  const fences = (await load("f.json")).json.fences;
  if (!Array.isArray(fences) || fences.length !== nChunks) throw new Error("bad fence file");
  const rowsCache = new Map(), chunkCache = new Map();
  const rowsOf = (k) => { if (!rowsCache.has(k)) rowsCache.set(k, load(`r/${k}.json`).then((r) => r.json.rows)); return rowsCache.get(k); };
  const chunkOf = (k) => { if (!chunkCache.has(k)) chunkCache.set(k, load(`c/${k}.bin`).then((r) => r.bytes)); return chunkCache.get(k); };
  const top = (await load("top.bin")).bytes;
  const rowAt = async (i) => { const r = (await rowsOf(Math.floor(i / C)))[i % C]; if (!r) throw new Error(`row ${i} missing from the proof files`); return r; };
  const prove = async (i) => {
    const [pid, occ, am, sc] = await rowAt(i);
    const r = { index: i, parcel_id: pid, occ, acres: unitsToDecimal(am, 6), lot_sqft: unitsToDecimal(sc, 2), acres_micro: String(am), sqft_centi: String(sc) };
    try {
      const leaf = await leafHashV2(county.fips, pid, occ, am, sc);
      const p = await assembleProofV2({ leaf, index: i, nLeaves: n, chunkSize: C, chunkBytes: await chunkOf(Math.floor(i / C)), topBytes: top });
      const proof = { version: 2, fips: county.fips, epoch: county.epoch, nLeaves: n, index: i, row: { id: pid, occ, acres_micro: String(am), sqft_centi: String(sc) }, siblings: p.siblings };
      const v = await verifyProofV2({ fips: county.fips, epoch: county.epoch, nLeaves: n, index: i, leaf: p.leaf, siblings: p.siblings }, root);
      Object.assign(r, { leaf: p.leaf, proofOk: v.ok, computed: v.computed, ok: v.ok && anchor.ok, proof,
        reason: v.ok ? (anchor.ok ? "" : "proof matches, but the on-chain root is not usable: " + (anchor.problems || []).join("; ")) : `the row's fingerprint path does not lead to the root (${v.why})` });
    } catch (e) { r.ok = false; r.reason = e.message || String(e); }
    return r;
  };
  // Binary search over leaves by key (fences narrow it to one or two chunks).
  const search = async (q) => {
    let lo = 0, hi = n;
    {
      let a = 0, b = nChunks; while (a < b) { const m = (a + b) >> 1; if (cmpKey(fences[m], q) < 0) a = m + 1; else b = m; }
      lo = Math.max(0, a - 1) * C; hi = Math.min(n, a * C); // the first leaf with key >= q lies in [lo, hi]
    }
    while (lo < hi) { const m = (lo + hi) >> 1; if (cmpKey(keyV2((await rowAt(m))[0]), q) < 0) lo = m + 1; else hi = m; }
    const matches = []; for (let i = lo; i < n && keyV2((await rowAt(i))[0]) === q; i++) matches.push(i);
    return { lo, matches };
  };
  const q = keyV2(typed);
  const { lo, matches } = await search(q);
  if (!matches.length && index.n_xshards) {
    // county aliases (e.g. a Property ID): a lookup aid only; the proof is on the parcel ID the alias points to
    const nk = normKey(typed), x = (await load(`x/${await shardOf(nk, index.n_xshards)}.json`)).json.entries[nk] ?? [];
    const rows = [], seen = new Map();
    for (const [id, t] of x) {
      if (!t || seen.has(id)) continue;
      const via = index.alias_types?.[t - 1]?.label ?? `alias ${t}`;
      seen.set(id, { id, via, aliasType: index.alias_types?.[t - 1] ?? null });
      for (const i of (await search(keyV2(id))).matches) if ((await rowAt(i))[0] === id) { const r = await prove(i); r.via = via; rows.push(r); }
    }
    if (rows.length) return { found: true, rows, anchor, leafVersion: 2, resolution: { typed, mode: "alias", matches: [...seen.values()].filter((m) => rows.some((r) => r.parcel_id === m.id)) } };
  }
  if (matches.length) {
    const rows = [];
    for (const i of matches) rows.push(await prove(i));
    const exact = rows.filter((r) => r.parcel_id.toUpperCase() === typed.toUpperCase()).length;
    const ids = [...new Set(rows.map((r) => r.parcel_id))];
    for (const r of rows) r.via = r.parcel_id.toUpperCase() === typed.toUpperCase() ? null : "normalized";
    const mode = exact === rows.length ? "exact" : "normalized";
    return { found: true, rows, anchor, leafVersion: 2, resolution: { typed, mode, matches: mode === "exact" ? [] : ids.map((id) => ({ id, via: "normalized" })) } };
  }
  // Not present: prove the gap between the two adjacent leaves around the key.
  const left = lo > 0 ? await prove(lo - 1) : null, right = lo < n ? await prove(lo) : null;
  const ordered = (!left || cmpKey(keyV2(left.parcel_id), q) < 0) && (!right || cmpKey(keyV2(right.parcel_id), q) > 0);
  const ok = !!(left || right) && ordered && (!left || left.ok) && (!right || right.ok);
  const suggestions = [];
  for (let i = lo; i < Math.min(n, lo + 10); i++) { const id = (await rowAt(i))[0]; if (keyV2(id).startsWith(q)) suggestions.push(id); }
  return { found: false, rows: [], anchor, leafVersion: 2, resolution: { typed, mode: "none", matches: [] }, suggestions,
           absence: { ok, key: q, left, right, reason: ok ? "" : !ordered ? "the neighbouring rows are not in key order" : "a neighbouring row's proof failed" } };
}

/** Rebuild a v2 root from canonical rows [[id, occ, acres_micro, sqft_centi], ...] in leaf order (audit/test helper). */
export async function rootFromRowsV2(fips, epoch, rows) {
  const leaves = []; const B = 4096;
  for (let i = 0; i < rows.length; i += B) leaves.push(...await Promise.all(rows.slice(i, i + B).map((r) => leafHashV2(fips, r[0], r[1], r[2], r[3]))));
  let lv = leaves;
  while (lv.length > 1) {
    const nx = [];
    for (let j = 0; j < lv.length; j += 2 * B) {
      const jobs = []; for (let k = j; k < Math.min(lv.length, j + 2 * B); k += 2) jobs.push(k + 1 < lv.length ? nodeHashV2(lv[k], lv[k + 1]) : Promise.resolve(lv[k]));
      nx.push(...await Promise.all(jobs));
    }
    lv = nx;
  }
  return { root: toHex(await rootHashV2(fips, epoch, rows.length, lv[0])), leaves };
}

// ---------------------------------------------------------------- program v2: county head, history, manifest
// Same rules as the SDK 0.3.0 (accounts.ts decodeCountyHead, rpc.ts fetchLatest, manifest.ts verifyManifest).
export const REASON_NAMES = { 0: "none", 1: "superseded", 2: "personal information", 3: "source error", 4: "duplicate", 5: "build error", 255: "other" };
export const STATUS_NAMES = { 1: "active", 2: "retracted", 3: "superseded" };
let HEAD_DISC;
export async function countyHeadDiscriminator() { return (HEAD_DISC ??= (await sha256(enc.encode("account:CountyHead"))).slice(0, 8)); }

/** Decode a CountyHead (48 bytes: disc | fips u32 | latest_epoch u32 | latest_active_epoch u32 | n_epochs u32 | updated_at i64 | bump u8 | reserved). */
export async function decodeCountyHead(data) {
  if (data.length < 33) throw new Error("account is too short to be a CountyHead");
  if (!eq(data.subarray(0, 8), await countyHeadDiscriminator())) throw new Error("account is not a CountyHead");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { fips: dv.getUint32(8, true), latestEpoch: dv.getUint32(12, true), latestActiveEpoch: dv.getUint32(16, true),
           nEpochs: dv.getUint32(20, true), updatedAt: Number(dv.getBigInt64(24, true)), bump: data[32] };
}

/**
 * getMultipleAccounts (finalized) for up to 100 addresses. Returns one entry per address: null (missing) or
 * { owner, data: Uint8Array }. Throws on network/RPC errors. Accounts not owned by CountyRoot are an error.
 */
export async function fetchAccounts(rpcUrl, addrs, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!addrs.length) return [];
  if (addrs.length > 100) throw new Error("at most 100 accounts per call");
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl?.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [addrs, { encoding: "base64", commitment: "finalized" }] }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`RPC error: ${j.error.message ?? JSON.stringify(j.error)}`);
    const vals = j.result?.value;
    if (!Array.isArray(vals) || vals.length !== addrs.length) throw new Error("RPC returned the wrong number of accounts");
    return vals.map((v, i) => {
      if (!v) return null;
      if (v.owner !== PROGRAM_ID) throw new Error(`account ${addrs[i]} is not owned by CountyRoot (owner ${v.owner})`);
      return { owner: v.owner, data: b64decode(v.data[0]) };
    });
  } finally { if (t) clearTimeout(t); }
}

/**
 * A county's on-chain history: the head (what is current) plus every listed epoch's status.
 * `county.head` is the head PDA and `county.history` = [{ epoch, pda }] (baked in at build time; the browser can't
 * derive PDAs). As with roots, a CountyRoot-owned CountyHead whose fips matches is the canonical one: only the
 * program writes it, from the same fips it uses as a seed. Returns { head, epochs: [{ epoch, pda, account }] }.
 * head is null if the county has no head yet (not migrated).
 */
export async function fetchHistory(rpcUrl, county, opts = {}) {
  const list = (county.history || []).slice(0, 99);
  const accts = await fetchAccounts(rpcUrl, [county.head, ...list.map((h) => h.pda)], opts);
  let head = null;
  if (accts[0]) { head = await decodeCountyHead(accts[0].data); if (head.fips !== county.fips) throw new Error(`county head is for fips ${head.fips}`); }
  const epochs = [];
  for (let i = 0; i < list.length; i++) {
    const a = accts[i + 1] ? await decodeCountyRoot(accts[i + 1].data) : null;
    if (a && (a.fips !== county.fips || a.epoch !== list[i].epoch)) throw new Error(`account ${list[i].pda} is fips ${a.fips} epoch ${a.epoch}`);
    epochs.push({ ...list[i], account: a });
  }
  return { head, epochs };
}

/** Plain-language status of one epoch, given the head. */
export function describeStatus(acct, head) {
  if (!acct) return { state: "missing", text: "not on-chain" };
  if (acct.status === STATUS_ACTIVE) return { state: "active", text: head && head.latestActiveEpoch === acct.epoch ? "active (current)" : "active" };
  if (acct.status === STATUS_SUPERSEDED) return { state: "superseded", text: `superseded${acct.supersededBy ? ` by epoch ${acct.supersededBy}` : " by a later epoch"}${acct.statusChangedAt ? ` on ${new Date(acct.statusChangedAt * 1000).toISOString().slice(0, 10)}` : ""} (still valid as history)` };
  if (acct.status === STATUS_RETRACTED) {
    const why = acct.retractReason ? REASON_NAMES[acct.retractReason] ?? `reason ${acct.retractReason}` : null;
    return { state: "retracted", text: `retracted${why ? ` (${why})` : ""}${acct.statusChangedAt ? ` on ${new Date(acct.statusChangedAt * 1000).toISOString().slice(0, 10)}` : ""}: do not rely on it` };
  }
  return { state: "unknown", text: `unknown status ${acct.status}` };
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
export const MANIFEST_KEYS = ["county_label", "fips", "epoch", "source_url", "source_query", "source_format", "fetched_at", "source_sha256",
  "source_record_count", "data_as_of", "builder_commit", "recipe", "leaf_version", "schema_sha256", "packet_sha256",
  "pii_scan", "n_parcels", "merkle_root", "supersedes_epoch", "reason"];
export const MANIFEST_OPTIONAL_KEYS = ["fetched_at_is_upper_bound", "fetched_at_source", "fetched_on"];
const isoToUnix = (s) => { if (s === null || s === undefined || s === "") return 0; const t = Date.parse(s); if (Number.isNaN(t)) throw new Error(`bad date ${s}`); return Math.floor(t / 1000); };

/**
 * Verify manifest bytes (exactly as downloaded) against a decoded v2 CountyRoot account, like the SDK's
 * verifyManifest: sha256 == manifest_sha256, canonical form, allowed keys, and fips/epoch/n_parcels/merkle_root/
 * packet+source hashes/leaf_version/fetched_at (+ upper-bound flag)/data_as_of agree with the chain.
 */
export async function verifyManifestBytes(bytes, acct) {
  const problems = [];
  if (!acct || !acct.manifestSha256) return { ok: false, problems: [`account is version ${acct?.version}; no on-chain manifest hash`], manifest: null };
  const sha = toHex(await sha256(bytes));
  if (sha !== acct.manifestSha256) problems.push("sha256(manifest) != on-chain manifest_sha256");
  let m = null;
  try { m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { problems.push("manifest is not JSON"); }
  if (m && (typeof m !== "object" || Array.isArray(m))) { problems.push("manifest is not a JSON object"); m = null; }
  if (m) {
    if (!eq(enc.encode(JSON.stringify(canon(m)) + "\n"), bytes)) problems.push("manifest is not in canonical form");
    const extra = Object.keys(m).filter((k) => !MANIFEST_KEYS.includes(k) && !MANIFEST_OPTIONAL_KEYS.includes(k));
    if (extra.length) problems.push(`unexpected manifest keys: ${extra.join(", ")}`);
    const same = (name, a, b) => { if (a !== b) problems.push(`${name}: manifest ${a} != on-chain ${b}`); };
    same("fips", m.fips, acct.fips); same("epoch", m.epoch, acct.epoch);
    same("n_parcels", String(m.n_parcels), String(acct.nParcels)); same("merkle_root", m.merkle_root, acct.merkleRoot);
    same("packet_sha256", m.packet_sha256, acct.packetSha256);
    same("source_sha256", m.source_sha256 ?? null, /^0{64}$/.test(acct.sourceSha256) ? null : acct.sourceSha256);
    same("leaf_version", m.leaf_version, acct.leafVersion);
    try { same("fetched_at", isoToUnix(m.fetched_at), acct.fetchedAt); } catch (e) { problems.push(e.message); }
    same("fetched_at_is_upper_bound", m.fetched_at_is_upper_bound === true, !!acct.fetchedAtIsUpperBound);
    try { same("data_as_of", isoToUnix(m.data_as_of), acct.dataAsOf); } catch (e) { problems.push(e.message); }
  }
  return { ok: problems.length === 0, problems, manifest: m, sha256: sha };
}
