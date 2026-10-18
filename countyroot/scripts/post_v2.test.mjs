// node --test scripts/post_v2.test.mjs   (SDK built). Fake RPC: nothing touches a network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadSdk } from "./verify.mjs";
import { buildV2 } from "./build_v2.mjs";
import { main, postRootIx, resolveBatch, ACCOUNT_LEN } from "./post_v2.mjs";

const sdk = await loadSdk();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "post-v2-"));
const attestor = Keypair.generate();

function v1Packet(dir, label, fips, n) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: n }, (_, i) => [`${label}-${i}`, (i / 4).toFixed(6), (i * 10890).toFixed(2)]);
  const leaves = rows.map(([p, a, s]) => sdk.leafHash(p, a, s));
  const csv = path.join(dir, `${label}.1.2026-10.csv`);
  fs.writeFileSync(csv, ["parcel_id,acres,lot_sqft,leaf", ...rows.map((r, i) => `${r.join(",")},${leaves[i].toString("hex")}`)].join("\n") + "\n");
  const root = sdk.merkleRoot(leaves).toString("hex");
  fs.writeFileSync(csv.replace(/\.csv$/, ".root.json"), JSON.stringify({ label, fips, epoch: 1, n_parcels: n, merkle_root: root }));
  return { csv, root };
}
const cr = ({ fips, epoch, n, root, schema, status = 1 }) => {
  const b = Buffer.alloc(99); sdk.ACCOUNT_DISCRIMINATORS.CountyRoot.copy(b, 0);
  b.writeUInt32LE(fips, 8); b.writeUInt32LE(epoch, 12); b.writeBigUInt64LE(BigInt(n), 16); Buffer.from(root, "hex").copy(b, 24); Buffer.from(schema).copy(b, 56); b[88] = status; b[98] = 1;
  return { owner: sdk.PROGRAM_ID, data: b, lamports: 1 };
};
const cfg = (att, paused = false) => { const b = Buffer.alloc(74); sdk.ACCOUNT_DISCRIMINATORS.Config.copy(b, 0); Keypair.generate().publicKey.toBuffer().copy(b, 8); att.toBuffer().copy(b, 40); b[72] = paused ? 1 : 0; return { owner: sdk.PROGRAM_ID, data: b }; };

/** A fake Connection: accounts by base58, signature history, balance. Records sends. */
function fakeConn({ accounts = {}, history = new Set(), balance = 10e9, failSim = false } = {}) {
  const sent = [];
  return { sent, accounts,
    getAccountInfo: async (k) => accounts[k.toBase58()] ?? null,
    getSignaturesForAddress: async (k) => (history.has(k.toBase58()) ? [{ signature: "x" }] : []),
    getMinimumBalanceForRentExemption: async (len) => (len === 99 ? 1153160 : 0),
    getBalance: async () => balance,
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    simulateTransaction: async () => ({ value: failSim ? { err: { InstructionError: [0, { Custom: 6001 }] }, logs: ["bad attestor"] } : { err: null, unitsConsumed: 9907, logs: [] } }),
    sendRawTransaction: async (raw) => { sent.push(raw); return `sig${sent.length}`; },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
}

// three counties built to v2 (offline)
const out = path.join(tmp, "v2");
const C = {};
for (const [label, fips, n] of [["A.ZZ", 99001, 9], ["B.ZZ", 99002, 5], ["C.ZZ", 99003, 12]]) {
  const p = v1Packet(path.join(tmp, "v1", label), label, fips, n);
  const s = await buildV2({ csvPath: p.csv, outDir: out, offline: true });
  C[label] = { fips, n, v1root: p.root, v2root: s.v2_root, rootPath: path.join(out, label, `${label}.2.2026-10.root.json`) };
}
const baseAccounts = () => {
  const a = { [sdk.configPda().toBase58()]: cfg(attestor.publicKey) };
  for (const c of Object.values(C)) a[sdk.countyRootPda(c.fips, 1).toBase58()] = cr({ fips: c.fips, epoch: 1, n: c.n, root: c.v1root, schema: sdk.SCHEMA_V1 });
  return a;
};
const run = async (argv, conn, signer = attestor) => { const log = []; const code = await main(argv, { log: (s) => log.push(s), connection: conn, signer }); return { code, log: log.join("\n") }; };

test("post_root instruction layout matches the program (discriminator, args, accounts)", () => {
  const ix = postRootIx(sdk, { fips: 40113, epoch: 3, nParcels: 41941, root: Buffer.alloc(32, 7), schema: sdk.SCHEMA_V2, attestor: attestor.publicKey });
  assert.equal(ix.data.length, 88);
  assert.ok(ix.data.subarray(0, 8).equals(sdk.discriminator("global:post_root")));
  assert.equal(ix.data.readUInt32LE(8), 40113); assert.equal(ix.data.readUInt32LE(12), 3); assert.equal(ix.data.readBigUInt64LE(16), 41941n);
  assert.ok(ix.data.subarray(56, 88).equals(sdk.SCHEMA_V2));
  assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[false, false], [false, true], [true, true], [false, false]]);
  assert.ok(ix.keys[1].pubkey.equals(sdk.countyRootPda(40113, 3)));
  assert.equal(ACCOUNT_LEN, 99);
});

test("dry run (default): checks, simulates, sends nothing; reports the SOL needed", async () => {
  const conn = fakeConn({ accounts: baseAccounts() });
  const r = await run(["--batch", "all", "--dir", out], conn);
  assert.equal(r.code, 0, r.log); assert.equal(conn.sent.length, 0);
  assert.match(r.log, /to post: 3, already posted: 0\. Needs 0\.003474 SOL/);
  assert.match(r.log, /dry run complete: 3 would be posted/);
  const r2 = await run(["--root", C["A.ZZ"].rootPath, "--send", "--dry-run"], conn);
  assert.equal(conn.sent.length, 0, "--dry-run wins over --send"); assert.equal(r2.code, 0);
});

test("send: posts, reads back, records state; a re-run resumes and skips what is already on-chain", async () => {
  const conn = fakeConn({ accounts: baseAccounts() });
  const state = path.join(tmp, "state.jsonl");
  // after each send, the account appears (the fake 'chain' applies the post)
  conn.sendRawTransaction = async (raw) => {
    conn.sent.push(raw);
    const c = Object.values(C)[conn.sent.length - 1];
    conn.accounts[sdk.countyRootPda(c.fips, 2).toBase58()] = cr({ fips: c.fips, epoch: 2, n: c.n, root: c.v2root, schema: sdk.SCHEMA_V2 });
    return `sig${conn.sent.length}`;
  };
  let r = await run(["--batch", "all", "--dir", out, "--state", state, "--max", "2", "--send"], conn);
  assert.equal(r.code, 0, r.log); assert.equal(conn.sent.length, 2);
  assert.equal(fs.readFileSync(state, "utf8").trim().split("\n").length, 2);
  r = await run(["--batch", "all", "--dir", out, "--state", state, "--send"], conn);
  assert.equal(r.code, 0, r.log); assert.equal(conn.sent.length, 3);
  assert.match(r.log, /skip A\.ZZ.*already posted/); assert.match(r.log, /posted 1, skipped 2/);
  r = await run(["--batch", "all", "--dir", out, "--state", state, "--send"], conn);
  assert.equal(conn.sent.length, 3); assert.match(r.log, /posted 0, skipped 3/);
});

test("refusals: wrong signer, paused, different root already there, closed epoch, retracted/missing v1, short balance, tampered CSV", async () => {
  const pdaA2 = sdk.countyRootPda(C["A.ZZ"].fips, 2).toBase58(), pdaA1 = sdk.countyRootPda(C["A.ZZ"].fips, 1).toBase58();
  const root = ["--root", C["A.ZZ"].rootPath];
  let r = await run(root, fakeConn({ accounts: baseAccounts() }), Keypair.generate());
  assert.equal(r.code, 1); assert.match(r.log, /not Config\.attestor/);
  r = await run(root, fakeConn({ accounts: { ...baseAccounts(), [sdk.configPda().toBase58()]: cfg(attestor.publicKey, true) } }));
  assert.match(r.log, /paused/);
  r = await run(root, fakeConn({ accounts: { ...baseAccounts(), [pdaA2]: cr({ fips: C["A.ZZ"].fips, epoch: 2, n: 9, root: "11".repeat(32), schema: sdk.SCHEMA_V2 }) } }));
  assert.equal(r.code, 1); assert.match(r.log, /already posted/);
  r = await run(root, fakeConn({ accounts: baseAccounts(), history: new Set([pdaA2]) }));
  assert.equal(r.code, 1); assert.match(r.log, /CLOSED/);
  r = await run(root, fakeConn({ accounts: { ...baseAccounts(), [pdaA1]: cr({ fips: C["A.ZZ"].fips, epoch: 1, n: 9, root: C["A.ZZ"].v1root, schema: sdk.SCHEMA_V1, status: 2 }) } }));
  assert.equal(r.code, 1); assert.match(r.log, /not ACTIVE/);
  r = await run(root, fakeConn({ accounts: { ...baseAccounts(), [pdaA1]: cr({ fips: C["A.ZZ"].fips, epoch: 1, n: 9, root: "22".repeat(32), schema: sdk.SCHEMA_V1 }) } }));
  assert.equal(r.code, 1); assert.match(r.log, /derived from/);
  r = await run([...root, "--send"], fakeConn({ accounts: baseAccounts(), balance: 1000 }));
  assert.equal(r.code, 1); assert.match(r.log, /short by/);
  r = await run(root, fakeConn({ accounts: baseAccounts(), failSim: true }));
  assert.equal(r.code, 1); assert.match(r.log, /simulation failed/);
  // tampered v2 CSV
  const csv = C["B.ZZ"].rootPath.replace(/\.root\.json$/, ".csv"), keep = fs.readFileSync(csv);
  fs.writeFileSync(csv, keep.toString().replace(/\n([^,\n]+),0,/, "\n$1,1,"));
  r = await run(["--root", C["B.ZZ"].rootPath], fakeConn({ accounts: baseAccounts() }));
  assert.equal(r.code, 1, r.log); fs.writeFileSync(csv, keep);
  // a v1 root.json is not accepted
  r = await run(["--root", path.join(tmp, "v1", "A.ZZ", "A.ZZ.1.2026-10.root.json")], fakeConn({ accounts: baseAccounts() }));
  assert.equal(r.code, 1); assert.match(r.log, /not a leaf_version 2/);
});

test("batch list file: labels, comments, root.json paths", () => {
  const f = path.join(tmp, "list.txt");
  fs.writeFileSync(f, `# first\nB.ZZ\n\n${C["C.ZZ"].rootPath}  # explicit\n`);
  assert.deepEqual(resolveBatch(f, out), [C["B.ZZ"].rootPath, C["C.ZZ"].rootPath]);
  assert.throws(() => { fs.writeFileSync(f, "NOPE.ZZ\n"); resolveBatch(f, out); }, /expected one v2 root\.json/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("retryingFetch retries network errors and 429, then returns", async () => {
  const { retryingFetch } = await import("./post_v2.mjs");
  let n = 0;
  const fetchImpl = async () => { n++; if (n === 1) throw new TypeError("fetch failed"); if (n === 2) return { status: 429 }; return { status: 200 }; };
  const r = await retryingFetch("x", {}, { fetchImpl, sleep: async () => {} });
  assert.equal(r.status, 200); assert.equal(n, 3);
  let m = 0;
  await assert.rejects(retryingFetch("x", {}, { tries: 3, fetchImpl: async () => { m++; throw new TypeError("fetch failed"); }, sleep: async () => {} }), /fetch failed/);
  assert.equal(m, 3);
});
