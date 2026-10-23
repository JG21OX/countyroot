#!/usr/bin/env node
// countyroot proof  --csv <packet.csv> --parcel <id> [--out proof.json]
// countyroot verify --root <root.json> (--proof <proof.json> | --csv <packet.csv> --parcel <id>)
//                   [--fips N --epoch N] [--rpc <url|devnet|mainnet>] [--commitment finalized|confirmed]
import fs from "fs";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { buildLevels, makeProof, packetLeaves, parsePacketCsv, verifyProof, Proof, leafHash } from "./merkle.js";
import { fetchCountyRoot } from "./rpc.js";
import { countyRootPda } from "./pda.js";
import { STATUS_ACTIVE, STATUS_NAMES, STATUS_RETRACTED, STATUS_SUPERSEDED, REASON_NAMES } from "./constants.js";
import type { CountyRoot } from "./accounts.js";

/** "fetched <iso>" or "fetched no later than <iso>" (flags.fetched_at_is_upper_bound); "" without provenance. */
export function fetchedText(acct: CountyRoot): string {
  const p = acct.provenance;
  if (!p || p.fetchedAt === 0n) return "";
  const t = new Date(Number(p.fetchedAt) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return p.fetchedAtIsUpperBound ? `fetched no later than ${t}` : `fetched ${t}`;
}
export function statusText(acct: CountyRoot): string {
  if (acct.status === STATUS_SUPERSEDED) return `SUPERSEDED by epoch ${acct.provenance?.supersededBy || "?"}`;
  if (acct.status === STATUS_RETRACTED) return `RETRACTED${acct.provenance?.retractReason ? ` (${REASON_NAMES[acct.provenance.retractReason] ?? acct.provenance.retractReason})` : ""}`;
  return STATUS_NAMES[acct.status] ?? `unknown status ${acct.status}`;
}
/** Retracted/unknown fails; superseded is a valid historical proof and only warns. */
export function checkStatus(acct: CountyRoot, log: (s: string) => void): boolean {
  if (acct.status === STATUS_ACTIVE) return true;
  if (acct.status === STATUS_SUPERSEDED) {
    log(`WARNING: not the latest epoch: superseded by epoch ${acct.provenance?.supersededBy || "?"} (proof is valid for this historical epoch only)`);
    return true;
  }
  log(acct.status === STATUS_RETRACTED ? "FAIL: root is retracted" : `FAIL: unknown status ${acct.status}`);
  return false;
}
import { verifyProofV2, SCHEMA_V1, SCHEMA_V2, ProofV2 } from "./leafv2.js";

function args(argv: string[]) {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected ${argv[i]}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

function proofFromCsv(csv: string, parcel: string): Proof & { parcel_id: string; acres: string; lot_sqft: string } {
  const rows = parsePacketCsv(fs.readFileSync(csv, "utf8"));
  const idx = rows.findIndex((r) => r.parcel_id === parcel);
  if (idx < 0) throw new Error(`parcel ${parcel} not found in ${csv}`);
  const levels = buildLevels(packetLeaves(rows));
  return { ...makeProof(levels, idx), parcel_id: rows[idx].parcel_id, acres: rows[idx].acres, lot_sqft: rows[idx].lot_sqft };
}

const rpcUrl = (v: string) => v.startsWith("http") ? v : clusterApiUrl(v === "mainnet" ? "mainnet-beta" : (v as any));

export async function main(argv: string[], log = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const a = args(rest);
  if (cmd === "proof") {
    if (!a.csv || !a.parcel) throw new Error("proof needs --csv and --parcel");
    const p = proofFromCsv(a.csv, a.parcel);
    const json = JSON.stringify(p, null, 2);
    if (a.out) fs.writeFileSync(a.out, json + "\n"); else log(json);
    return 0;
  }
  if (cmd !== "verify") { log("usage: countyroot proof|verify ... (see README)"); return 2; }
  if (!a.root) throw new Error("verify needs --root <root.json>");
  const rootDoc = JSON.parse(fs.readFileSync(a.root, "utf8"));
  const proof: any = a.proof ? JSON.parse(fs.readFileSync(a.proof, "utf8")) : a.csv && a.parcel ? proofFromCsv(a.csv, a.parcel) : null;
  if (!proof) throw new Error("verify needs --proof, or --csv and --parcel");
  const fips = a.fips ? Number(a.fips) : rootDoc.fips, epoch = a.epoch ? Number(a.epoch) : rootDoc.epoch;
  if (fips !== rootDoc.fips || epoch !== rootDoc.epoch) { log(`FAIL: root.json is fips ${rootDoc.fips} epoch ${rootDoc.epoch}`); return 1; }
  if (proof.version === 2) return verifyV2(proof as ProofV2, rootDoc, fips, epoch, a, log);
  let ok = true;
  if (a.parcel && proof.parcel_id !== undefined && proof.parcel_id !== a.parcel) { log("FAIL: proof is for a different parcel"); return 1; }
  if (proof.parcel_id !== undefined) {
    const h = leafHash(proof.parcel_id, proof.acres, proof.lot_sqft).toString("hex");
    if (h !== proof.leaf) { log("FAIL: leaf does not match parcel_id|acres|lot_sqft"); ok = false; }
  }
  if (Number(rootDoc.n_parcels) !== proof.leafCount) { log(`FAIL: proof leafCount ${proof.leafCount} != n_parcels ${rootDoc.n_parcels}`); ok = false; }
  const offline = verifyProof(proof, rootDoc.merkle_root);
  log(`${offline ? "OK  " : "FAIL"} proof -> root.json merkle_root ${rootDoc.merkle_root} (fips ${fips}, epoch ${epoch}, leaf ${proof.index + 1}/${proof.leafCount})`);
  ok &&= offline;
  if (a.rpc) {
    const conn = new Connection(rpcUrl(a.rpc), (a.commitment as any) ?? "finalized");
    const acct = await fetchCountyRoot(conn, fips, epoch, (a.commitment as any) ?? "finalized");
    if (!acct) { log(`FAIL: no on-chain account ${countyRootPda(fips, epoch).toBase58()}`); return 1; }
    const onchain = acct.merkleRoot.toString("hex");
    const match = onchain === rootDoc.merkle_root && verifyProof(proof, acct.merkleRoot);
    log(`${match ? "OK  " : "FAIL"} on-chain root ${onchain} (status ${statusText(acct)}, version ${acct.version}, n_parcels ${acct.nParcels})`);
    if (fetchedText(acct)) log(`     source data ${fetchedText(acct)}`);
    if (!checkStatus(acct, log)) ok = false;
    if (acct.nParcels !== BigInt(proof.leafCount)) { log("FAIL: on-chain n_parcels differs from proof leafCount"); ok = false; }
    ok &&= match;
  }
  log(ok ? "VERIFIED" : "NOT VERIFIED");
  return ok ? 0 : 1;
}

/** Leaf format v2 proof: the root binds fips/epoch/n, and the on-chain schema must be SCHEMA_V2. */
async function verifyV2(proof: ProofV2, rootDoc: any, fips: number, epoch: number, a: Record<string, string>, log: (s: string) => void): Promise<number> {
  let ok = true;
  if (proof.fips !== fips || proof.epoch !== epoch) { log(`FAIL: proof is for fips ${proof.fips} epoch ${proof.epoch}`); ok = false; }
  if (Number(rootDoc.n_parcels) !== proof.nLeaves) { log(`FAIL: proof nLeaves ${proof.nLeaves} != n_parcels ${rootDoc.n_parcels}`); ok = false; }
  if (a.parcel && proof.row.id !== a.parcel) { log("FAIL: proof is for a different parcel"); ok = false; }
  const offline = verifyProofV2(proof, rootDoc.merkle_root);
  log(`${offline ? "OK  " : "FAIL"} v2 proof -> root.json merkle_root ${rootDoc.merkle_root} (fips ${fips}, epoch ${epoch}, leaf ${proof.index + 1}/${proof.nLeaves})`);
  ok &&= offline;
  if (a.rpc) {
    const conn = new Connection(rpcUrl(a.rpc), (a.commitment as any) ?? "finalized");
    const acct = await fetchCountyRoot(conn, fips, epoch, (a.commitment as any) ?? "finalized");
    if (!acct) { log(`FAIL: no on-chain account ${countyRootPda(fips, epoch).toBase58()}`); return 1; }
    const match = verifyProofV2(proof, acct.merkleRoot);
    const fmt = acct.schema.equals(SCHEMA_V2) ? "v2" : acct.schema.equals(SCHEMA_V1) ? "v1" : "unknown";
    log(`${match ? "OK  " : "FAIL"} on-chain root ${acct.merkleRoot.toString("hex")} (format ${fmt}, status ${statusText(acct)})`);
    if (fetchedText(acct)) log(`     source data ${fetchedText(acct)}`);
    if (fmt !== "v2") { log("FAIL: the on-chain root is not a v2 fingerprint"); ok = false; }
    if (!checkStatus(acct, log)) ok = false;
    if (acct.nParcels !== BigInt(proof.nLeaves)) { log("FAIL: on-chain n_parcels differs from proof nLeaves"); ok = false; }
    ok &&= match;
  }
  log(ok ? "VERIFIED" : "NOT VERIFIED");
  return ok ? 0 : 1;
}

import { pathToFileURL } from "url";
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(2); });
