// Local rehearsal of the Devnet migration on solana-test-validator (127.0.0.1 only; never Devnet).
//   bash scripts/build-programs.sh && node scripts/rehearse_migration.mjs
// Loads target/deploy/countyroot-devnet.so at the real program id, seeds Config and legacy 99-byte roots for
// test counties (FIPS 99001..99004), then runs migrate_v2.mjs: manifests -> dry run -> --send -> re-run (no-op),
// and checks the result with the SDK (decode, fetchLatest, verifyManifest).
import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert/strict";
import { spawn } from "child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadSdk } from "./verify.mjs";
import { buildV2 } from "./build_v2.mjs";
import { main as migrate } from "./migrate_v2.mjs";
import { run as setPaused } from "./set_paused.mjs";

const sdk = await loadSdk();
const here = path.dirname(new URL(import.meta.url).pathname), repo = path.resolve(here, "..");
const so = path.join(repo, "target/deploy/countyroot-devnet.so");
if (!fs.existsSync(so)) throw new Error("build first: bash scripts/build-programs.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-rehearsal-"));
const attestor = Keypair.generate(), authority = Keypair.generate();
const kpFile = path.join(tmp, "attestor.json"); fs.writeFileSync(kpFile, JSON.stringify(Array.from(attestor.secretKey)));

const acct = (pubkey, data, lamports) => ({ pubkey: pubkey.toBase58(), account: { lamports, data: [data.toString("base64"), "base64"], owner: sdk.PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: data.length } });
const rent = (len) => (128 + len) * 6960;               // generous; test validator rent
const files = [];
const put = (name, a) => { const f = path.join(tmp, name + ".json"); fs.writeFileSync(f, JSON.stringify(a)); files.push(["--account", a.pubkey, f]); };
{ const [cfgPda, bump] = PublicKey.findProgramAddressSync([Buffer.from("config")], sdk.PROGRAM_ID);
  const b = Buffer.alloc(74); sdk.ACCOUNT_DISCRIMINATORS.Config.copy(b, 0); authority.publicKey.toBuffer().copy(b, 8); attestor.publicKey.toBuffer().copy(b, 40); b[72] = 0; b[73] = bump;
  put("config", acct(cfgPda, b, rent(74))); }
function legacy({ fips, epoch, n, root, schema, status }) {
  const [k, bump] = PublicKey.findProgramAddressSync([Buffer.from("county_root"), u32(fips), u32(epoch)], sdk.PROGRAM_ID);
  const b = Buffer.alloc(99); sdk.ACCOUNT_DISCRIMINATORS.CountyRoot.copy(b, 0);
  b.writeUInt32LE(fips, 8); b.writeUInt32LE(epoch, 12); b.writeBigUInt64LE(BigInt(n), 16); Buffer.from(root, "hex").copy(b, 24); Buffer.from(schema).copy(b, 56);
  b[88] = status; b.writeBigInt64LE(1_700_000_000n, 89); b[97] = bump; b[98] = 1;
  put(`root-${fips}-${epoch}`, acct(k, b, rent(99)));
}
const u32 = (x) => { const b = Buffer.alloc(4); b.writeUInt32LE(x); return b; };

// packets: v1 epoch 1, v2 epoch 2 (same parcels), built offline like the real pipeline
const v2dir = path.join(tmp, "v2"); const C = [];
// B.ZZ carries a real-style " / City, ST" label (spaces, comma, slash) to exercise manifestFileName.
const fullLabel = (l) => (l === "B.ZZ" ? "B.ZZ / Bee Town/Hive, ZZ" : l);
for (const [label, fips, n, e2status] of [["A.ZZ", 99001, 9, 1], ["B.ZZ", 99002, 5, 1], ["C.ZZ", 99003, 12, 2]]) {
  const d = path.join(tmp, "v1", label); fs.mkdirSync(d, { recursive: true });
  const rows = Array.from({ length: n }, (_, i) => [`${label}-${i}`, (i / 4).toFixed(6), (i * 10890).toFixed(2)]);
  const leaves = rows.map(([p, a, s]) => sdk.leafHash(p, a, s));
  const csv = path.join(d, `${label}.1.2026-10.csv`);
  fs.writeFileSync(csv, ["parcel_id,acres,lot_sqft,leaf", ...rows.map((r, i) => `${r.join(",")},${leaves[i].toString("hex")}`)].join("\n") + "\n");
  const v1root = sdk.merkleRoot(leaves).toString("hex");
  fs.writeFileSync(csv.replace(/\.csv$/, ".root.json"), JSON.stringify({ label: fullLabel(label), fips, epoch: 1, n_parcels: n, merkle_root: v1root }));
  const s = await buildV2({ csvPath: csv, outDir: v2dir, offline: true });
  legacy({ fips, epoch: 1, n, root: v1root, schema: sdk.SCHEMA_V1, status: 1 });
  legacy({ fips, epoch: 2, n, root: s.v2_root, schema: sdk.SCHEMA_V2, status: e2status });
  C.push({ label, fips, n, v2root: s.v2_root, e2status });
}

const ledger = path.join(tmp, "ledger");
const args = ["--reset", "--quiet", "--ledger", ledger, "--rpc-port", "8899", "--faucet-port", "9910", "--bind-address", "127.0.0.1",
  "--upgradeable-program", sdk.PROGRAM_ID.toBase58(), so, authority.publicKey.toBase58(), ...files.flat()];
const v = spawn("solana-test-validator", args, { stdio: "ignore" });
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const log = (s) => console.log("  " + s);
let code = 1;
try {
  for (let i = 0; ; i++) { try { await conn.getLatestBlockhash(); break; } catch { if (i > 120) throw new Error("validator did not start"); await new Promise((r) => setTimeout(r, 500)); } }
  await conn.confirmTransaction(await conn.requestAirdrop(attestor.publicKey, 10e9), "confirmed");
  const mdir = path.join(tmp, "manifests"); fs.writeFileSync(path.join(tmp, "labels.txt"), C.map((c) => c.label).join("\n"));
  const run = async (argv) => { console.log(`$ migrate_v2.mjs ${argv.join(" ")}`); const r = await migrate(argv, { log }); return r; };
  const meta = path.join(tmp, "meta.json");
  fs.writeFileSync(meta, JSON.stringify(Object.fromEntries(C.map((c) => [fullLabel(c.label), { county_label: `${c.label[0]} County, ZZ`, ...(c.label === "B.ZZ"
    ? { fetched_at: null, fetched_no_later_than: "2026-10-02T08:30:00Z", fetched_no_later_than_source: "git rehearsal adds post script [commit time]", fetched_on: "2026-10-01" }
    : { fetched_at: "2026-10-01T12:00:00Z" }), data_as_of: "2026-09-30T00:00:00Z", source_url: "https://example.gov/parcels.zip", source_format: "shapefile" }]))));
  fs.writeFileSync(path.join(tmp, "nometa.json"), "{}");
  assert.equal(await run(["manifests", "--batch", path.join(tmp, "labels.txt"), "--dir", v2dir, "--out", mdir, "--meta", path.join(tmp, "nometa.json")]), 1);
  assert.equal(await run(["manifests", "--batch", path.join(tmp, "labels.txt"), "--dir", v2dir, "--out", mdir, "--meta", meta, "--builder-commit", "rehearsal"]), 0);
  const authFile = path.join(tmp, "authority.json"); fs.writeFileSync(authFile, JSON.stringify(Array.from(authority.secretKey)));
  await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 1e9), "confirmed");
  assert.ok((await setPaused(["--paused", "true", "--authority", authFile, "--cluster", "localnet", "--send"], { connection: conn, log })).ok);
  const common0 = ["--manifests", mdir, "--cluster", "localnet", "--keypair", kpFile];
  assert.equal(await run(["run", ...common0]), 1, "refuses while paused");
  assert.ok((await setPaused(["--paused", "false", "--authority", authFile, "--cluster", "localnet", "--send"], { connection: conn, log })).ok);
  const common = ["--manifests", mdir, "--cluster", "localnet", "--keypair", kpFile, "--state", path.join(tmp, "state.jsonl")];
  assert.equal(await run(["run", ...common]), 0);                                       // dry run (simulated)
  for (const c of C) assert.equal((await conn.getAccountInfo(sdk.countyRootPda(c.fips, 2))).data.length, 99, "dry run changed nothing");
  assert.equal(await run(["run", ...common, "--send"]), 0);
  assert.equal(await run(["run", ...common, "--send"]), 0);                             // idempotent re-run
  for (const c of C) {
    const e1 = await sdk.fetchCountyRoot(conn, c.fips, 1, "confirmed"), e2i = await conn.getAccountInfo(sdk.countyRootPda(c.fips, 2));
    const latest = await sdk.fetchLatest(conn, c.fips, "confirmed");
    if (c.e2status === 1) {
      assert.equal(e2i.data.length, 256); const e2 = sdk.decodeCountyRoot(e2i.data);
      assert.equal(e2.provenance.migrated, true);
      const ub = c.label === "B.ZZ";
      assert.equal(e2i.data[233], ub ? 3 : 1, "flags byte"); assert.equal(e2.provenance.fetchedAtIsUpperBound, ub);
      assert.equal(new Date(Number(e2.provenance.fetchedAt) * 1000).toISOString(), ub ? "2026-10-02T08:30:00.000Z" : "2026-10-01T12:00:00.000Z");
      if (ub) log(`checked ${c.label}: flags=3 (MIGRATED|FETCHED_AT_IS_UPPER_BOUND), fetched no later than 2026-10-02T08:30:00Z`); assert.equal(e1.status, sdk.STATUS_SUPERSEDED);
      assert.equal(latest.epoch, 2); assert.equal(latest.root.merkleRoot.toString("hex"), c.v2root);
      const mf = `${c.label}.${String(c.fips).padStart(5, "0")}.e2.manifest.json`; assert.ok(fs.existsSync(path.join(mdir, mf)), mf);
      assert.deepEqual(sdk.verifyManifest(fs.readFileSync(path.join(mdir, mf)), e2).problems, []);
      log(`checked ${c.label}: e2 migrated (256 B), e1 SUPERSEDED, fetchLatest -> e2, verifyManifest OK`);
    } else {
      // D5: retracted newest epoch -> head(latest 2, active 0), e1 SUPERSEDED by 2, e2 untouched
      assert.equal(e2i.data.length, 99, "retracted root is not migrated"); assert.equal(sdk.decodeCountyRoot(e2i.data).status, sdk.STATUS_RETRACTED);
      assert.equal(e1.status, sdk.STATUS_SUPERSEDED);
      assert.equal(latest.head.latestEpoch, 2); assert.equal(latest.head.latestActiveEpoch, 0);
      assert.equal(latest.epoch, 0); assert.equal(latest.root, null);
      log(`checked ${c.label}: latest epoch retracted -> head latest=2 active=0, e1 SUPERSEDED, e2 left RETRACTED (99 B), fetchLatest -> no active root`);
    }
  }
  console.log("REHEARSAL OK"); code = 0;
} catch (e) { console.error("REHEARSAL FAILED:", e.message); }
finally { v.kill("SIGINT"); fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(code);
