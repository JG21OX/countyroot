import { createHash } from "crypto";
import type { CountyRoot } from "./accounts.js";

/**
 * Off-chain provenance manifest `<X>.e<N>.manifest.json`. Only these keys are allowed; the
 * manifest carries no parcel rows, owner names or site addresses.
 */
export const MANIFEST_KEYS = [
  "county_label", "fips", "epoch", "source_url", "source_query", "source_format", "fetched_at", "source_sha256",
  "source_record_count", "data_as_of", "builder_commit", "recipe", "leaf_version", "schema_sha256", "packet_sha256",
  "pii_scan", "n_parcels", "merkle_root", "supersedes_epoch", "reason",
] as const;

function canon(v: any): any {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
/** Canonical bytes: keys sorted at every level, no whitespace, UTF-8, one trailing LF. */
export function canonicalManifest(m: Record<string, any>): Buffer {
  return Buffer.from(JSON.stringify(canon(m)) + "\n", "utf8");
}
export const manifestSha256 = (bytes: Buffer | Uint8Array) => createHash("sha256").update(bytes).digest();

/** "2026-10-01T00:00:00Z" | null -> unix seconds (0 for null). */
export function isoToUnix(s: string | null | undefined): bigint {
  if (s === null || s === undefined || s === "") return 0n;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad date ${s}`);
  return BigInt(Math.floor(t / 1000));
}

export interface ManifestCheck { ok: boolean; problems: string[]; manifest: Record<string, any> | null; }

/**
 * Verify manifest bytes (exactly as downloaded) against an on-chain CountyRoot v2 account:
 * sha256 == manifest_sha256, canonical form, and fips/epoch/n_parcels/merkle_root/hashes/dates agree.
 */
export function verifyManifest(bytes: Buffer | Uint8Array, root: CountyRoot): ManifestCheck {
  const problems: string[] = [];
  const p = root.provenance;
  if (!p) return { ok: false, problems: [`account is version ${root.version}; no on-chain manifest hash`], manifest: null };
  const buf = Buffer.from(bytes);
  if (!manifestSha256(buf).equals(p.manifestSha256)) problems.push("sha256(manifest) != on-chain manifest_sha256");
  let m: Record<string, any> | null = null;
  try { m = JSON.parse(buf.toString("utf8")); } catch { problems.push("manifest is not JSON"); }
  if (m) {
    if (!canonicalManifest(m).equals(buf)) problems.push("manifest is not in canonical form");
    const extra = Object.keys(m).filter((k) => !(MANIFEST_KEYS as readonly string[]).includes(k));
    if (extra.length) problems.push(`unexpected manifest keys: ${extra.join(", ")}`);
    const eq = (name: string, a: any, b: any) => { if (a !== b) problems.push(`${name}: manifest ${a} != on-chain ${b}`); };
    eq("fips", m.fips, root.fips);
    eq("epoch", m.epoch, root.epoch);
    eq("n_parcels", String(m.n_parcels), root.nParcels.toString());
    eq("merkle_root", m.merkle_root, root.merkleRoot.toString("hex"));
    eq("packet_sha256", m.packet_sha256, p.packetSha256.toString("hex"));
    const zero = p.sourceSha256.equals(Buffer.alloc(32));
    eq("source_sha256", m.source_sha256 ?? null, zero ? null : p.sourceSha256.toString("hex"));
    eq("leaf_version", m.leaf_version, p.leafVersion);
    try { eq("fetched_at", isoToUnix(m.fetched_at).toString(), p.fetchedAt.toString()); } catch (e: any) { problems.push(e.message); }
    try { eq("data_as_of", isoToUnix(m.data_as_of).toString(), p.dataAsOf.toString()); } catch (e: any) { problems.push(e.message); }
  }
  return { ok: problems.length === 0, problems, manifest: m };
}
