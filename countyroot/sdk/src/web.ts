// @countyroot/sdk/web: dependency-free parcel verification for browsers, Node >= 19, Deno and Bun.
// Uses WebCrypto and fetch only. Proof files come from packets.countyroot.com; the root is read from the
// county's CountyRoot PDA on Solana. Nothing in the proof files is trusted: a parcel only verifies if the
// recomputed root equals the active on-chain root.
// @ts-ignore vendored plain-JS module
import * as core from "./web/core.js";
const cr: any = core;

export const DEFAULTS = {
  site: "https://countyroot.com",
  packets: "https://packets.countyroot.com",
  rpc: "https://api.devnet.solana.com",
  cluster: "devnet",
} as const;
export const PROGRAM_ID: string = cr.PROGRAM_ID;

export interface County {
  label: string; display?: string; state?: string; city?: string;
  fips: number; epoch: number; month: string; n_parcels: number; merkle_root: string; pda: string; leaf_version?: number;
}
export interface CountyRootAccount {
  fips: number; epoch: number; nParcels: bigint; merkleRoot: string; schema: string;
  status: number; postedAt: number; bump: number; version: number; slot?: number;
  /** v2 (version >= 2, 256-byte) accounts only. */
  manifestSha256?: string; sourceSha256?: string; packetSha256?: string; dataAsOf?: number; fetchedAt?: number;
  statusChangedAt?: number; supersededBy?: number; retractReason?: number; leafVersion?: number; migrated?: boolean;
}
export interface Anchor {
  kind: "onchain" | "onchain-missing" | "published"; ok: boolean; root?: string; nParcels?: number;
  status?: number; postedAt?: number; schema?: string; slot?: number; problems?: string[]; note?: string;
  /** false when the epoch is SUPERSEDED (proof is historical, not current). */
  current?: boolean; supersededBy?: number | null; retractReason?: number | null; manifestSha256?: string | null; warnings?: string[];
}
export interface ParcelRow {
  index: number; parcel_id: string; acres: string; lot_sqft: string; leaf?: string;
  ok: boolean; proofOk?: boolean; computed?: string; reason: string; via?: string | null; proof?: unknown;
}
export interface VerifyResult {
  /** true only if the parcel was found, every proof matched, and the root was read from an active on-chain account. */
  verified: boolean;
  found: boolean; county: County; anchor: Anchor; rows: ParcelRow[];
  resolution?: unknown; suggestions?: string[]; absence?: unknown; leafVersion?: number;
}
export interface Options { site?: string; packets?: string; rpc?: string; fetch?: typeof fetch; /** RPC timeout, default 8000 ms. */ timeoutMs?: number; }

const f = (o: Options) => o.fetch ?? globalThis.fetch;

/** All live counties (label, FIPS, current epoch, PDA, published root), from countyroot.com/verify/counties.json. */
export async function listCounties(opts: Options = {}): Promise<County[]> {
  const r = await f(opts)(`${opts.site ?? DEFAULTS.site}/verify/counties.json`);
  if (!r.ok) throw new Error(`counties.json: HTTP ${r.status}`);
  return (await r.json()).counties;
}

/** Find a county by label ("Travis.TX") or FIPS (48453). */
export async function getCounty(which: string | number, opts: Options = {}): Promise<County> {
  const all = await listCounties(opts);
  const c = all.find((x) => (typeof which === "number" ? x.fips === which : x.label.toLowerCase() === String(which).toLowerCase()));
  if (!c) throw new Error(`unknown county: ${which}`);
  return c;
}

/** Read and decode a county's CountyRoot PDA (finalized). Checks the owner is the CountyRoot program. null if missing. */
export async function readCountyRoot(pda: string, opts: Options = {}): Promise<CountyRootAccount | null> {
  return cr.fetchCountyRoot(opts.rpc ?? DEFAULTS.rpc, pda, { fetchImpl: f(opts), timeoutMs: opts.timeoutMs ?? 8000 });
}

/** Loader for one county's proof files on packets.countyroot.com. */
export function proofLoader(c: County, opts: Options = {}) {
  const base = `${opts.packets ?? DEFAULTS.packets}/${c.label}/${c.label}.${c.epoch}.${c.month}.proofs/`;
  return async (name: string) => {
    const r = await f(opts)(base + name);
    if (r.status === 404 || r.status === 403) throw Object.assign(new Error(`missing ${name}`), { notFound: true });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return name.endsWith(".json") ? { json: await r.json() } : { bytes: new Uint8Array(await r.arrayBuffer()) };
  };
}

/** Verify one parcel ID: fetch its proof from packets.countyroot.com and check it against the county PDA on Solana. */
export async function verifyParcel(county: string | number | County, parcelId: string, opts: Options = {}): Promise<VerifyResult> {
  const c = typeof county === "object" ? county : await getCounty(county, opts);
  const res = await cr.verifyParcel({ county: c, parcelId, load: proofLoader(c, opts), onchain: (cc: County) => readCountyRoot(cc.pda, opts) });
  const verified = !!res.found && res.anchor.kind === "onchain" && res.anchor.ok && res.rows.length > 0 && res.rows.every((r: ParcelRow) => r.ok);
  return { ...res, verified, county: c };
}

export const STATUS_ACTIVE = 1;
export const STATUS_RETRACTED = 2;
export const STATUS_SUPERSEDED = 3;
export { core };
