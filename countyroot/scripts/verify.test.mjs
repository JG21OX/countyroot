// node --test scripts/verify.test.mjs
// Needs the SDK built (cd sdk && npm ci && npm run build). Set COUNTYROOT_PACKET=<path/X.csv> (with X.root.json
// beside it) to run the real-packet tests; the end-to-end script test also needs the matching post_*.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import { verifyPacket, checkEpochPolicy, main, VerifyError, loadSdk } from "./verify.mjs";
import { guardProgram } from "./preflight.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-verify-"));
const { leafHash, merkleRoot, countyRootPda, ACCOUNT_DISCRIMINATORS, PROGRAM_ID } = await loadSdk();

// Small synthetic packet in the real format.
function writePacket(dir, { label = "Test.ZZ", fips = 99001, epoch = 1, rows, mutate } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  rows ??= Array.from({ length: 7 }, (_, i) => [`P-${i}`, (i * 1.25).toFixed(6), (i * 54450).toFixed(2)]);
  const leaves = rows.map(([p, a, s]) => leafHash(p, a, s));
  const lines = ["parcel_id,acres,lot_sqft,leaf", ...rows.map((r, i) => `${r.join(",")},${leaves[i].toString("hex")}`)];
  const doc = { label, fips, epoch, n_parcels: rows.length, merkle_root: merkleRoot(leaves).toString("hex"), packet_file: `${label}.${epoch}.2026-10.csv` };
  if (mutate) mutate(lines, doc);
  const csv = path.join(dir, doc.packet_file);
  fs.writeFileSync(csv, lines.join("\n") + "\n");
  fs.writeFileSync(csv.replace(/\.csv$/, ".root.json"), JSON.stringify(doc));
  return { csv, doc };
}
const fails = async (p, re) => { await assert.rejects(p, (e) => e instanceof VerifyError && re.test(e.message)); };

test("synthetic packet passes", async () => {
  const { csv, doc } = writePacket(path.join(tmp, "ok"));
  const r = await verifyPacket({ csvPath: csv, expect: { fips: doc.fips, epoch: doc.epoch, nParcels: doc.n_parcels, merkleRoot: doc.merkle_root } });
  assert.ok(r.ok);
});

test("tampered acres (leaf column kept) fails", async () => {
  const { csv } = writePacket(path.join(tmp, "acres"), { mutate: (l) => { const c = l[3].split(","); c[1] = "9.000000"; l[3] = c.join(","); } });
  await fails(verifyPacket({ csvPath: csv }), /row 4 \(P-2\): stored leaf .* != recomputed/);
});

test("tampered parcel row with consistent leaf fails on the root", async () => {
  const { csv } = writePacket(path.join(tmp, "row"), { mutate: (l) => {
    l[2] = `P-X,1.250000,54450.00,${leafHash("P-X", "1.250000", "54450.00").toString("hex")}`; } });
  await fails(verifyPacket({ csvPath: csv }), /rebuilt root .* != root.json merkle_root/);
});

test("wrong root fails (in root.json, and vs the value to post)", async () => {
  const { csv } = writePacket(path.join(tmp, "root"), { mutate: (_l, d) => { d.merkle_root = "00".repeat(32); } });
  await fails(verifyPacket({ csvPath: csv }), /rebuilt root/);
  const ok = writePacket(path.join(tmp, "root2"));
  await fails(verifyPacket({ csvPath: ok.csv, expect: { merkleRoot: "11".repeat(32) } }), /merkle_root to post/);
});

test("wrong n_parcels fails (root.json and value to post)", async () => {
  const { csv } = writePacket(path.join(tmp, "n"), { mutate: (_l, d) => { d.n_parcels = 8; } });
  await fails(verifyPacket({ csvPath: csv }), /CSV has 7 rows but root.json n_parcels is 8/);
  const ok = writePacket(path.join(tmp, "n2"));
  await fails(verifyPacket({ csvPath: ok.csv, expect: { nParcels: 6 } }), /n_parcels to post \(6\)/);
  await fails(verifyPacket({ csvPath: ok.csv, expect: { fips: 1 } }), /fips to post/);
  await fails(verifyPacket({ csvPath: ok.csv, expect: { epoch: 2 } }), /epoch to post/);
});

test("closed epoch is refused (local list and on-chain history); retracted refused", async () => {
  await fails(checkEpochPolicy({ fips: 99001, epoch: 1 }, { closedEpochs: [{ fips: 99001, epoch: 1 }] }), /closed-epochs.json/);
  const conn = (info, sigs) => ({ getAccountInfo: async () => info, getSignaturesForAddress: async () => sigs });
  await fails(checkEpochPolicy({ fips: 99001, epoch: 1 }, { connection: conn(null, [{ signature: "x" }]), closedEpochs: [] }), /CLOSED on-chain/);
  const acct = (status) => ({ owner: PROGRAM_ID, data: Buffer.concat([ACCOUNT_DISCRIMINATORS.CountyRoot, Buffer.alloc(80), Buffer.from([status]), Buffer.alloc(9)]) });
  await fails(checkEpochPolicy({ fips: 99001, epoch: 1, op: "update" }, { connection: conn(acct(2), []), closedEpochs: [] }), /RETRACTED/);
  await fails(checkEpochPolicy({ fips: 99001, epoch: 1, op: "post" }, { connection: conn(acct(1), []), closedEpochs: [] }), /already posted/);
  assert.deepEqual(await checkEpochPolicy({ fips: 99001, epoch: 1 }, { connection: conn(null, []), closedEpochs: [] }), { rpc: true });
});

test("CLI exit codes and messages", async () => {
  const ok = writePacket(path.join(tmp, "cli"));
  const out = []; assert.equal(await main(["--csv", ok.csv], (s) => out.push(s)), 0); assert.match(out[0], /^VERIFIED/);
  const bad = writePacket(path.join(tmp, "cli2"), { mutate: (_l, d) => { d.n_parcels = 1; } });
  out.length = 0; assert.equal(await main(["--csv", bad.csv], (s) => out.push(s)), 1); assert.match(out[0], /^VERIFY FAILED: CSV has 7 rows/);
  out.length = 0; assert.equal(await main(["--label", "Test.ZZ", "--epoch", "1", "--dir", path.join(tmp, "cli")], (s) => out.push(s)), 0);
});

test("guardProgram aborts before any send on failure; --skip-verify sends with a warning", async () => {
  const { doc } = writePacket(path.join(tmp, "guard"));
  let sent = 0;
  const fakeProgram = () => ({ provider: {}, methods: { postRoot: (...args) => ({ accounts() { return this; }, async rpc() { sent++; return "SIG"; } }) } });
  const args = (root, n) => [doc.fips, doc.epoch, n, Buffer.from(root, "hex"), Buffer.alloc(32)];
  const opts = { locate: () => path.join(tmp, "guard", `${doc.label}.1.2026-10.root.json`), connection: { getAccountInfo: async () => null, getSignaturesForAddress: async () => [] } };
  const p = guardProgram(fakeProgram(), opts);
  await assert.rejects(p.methods.postRoot(...args("22".repeat(32), doc.n_parcels)).accounts({}).rpc(), /merkle_root to post/);
  assert.equal(sent, 0);
  assert.equal(await p.methods.postRoot(...args(doc.merkle_root, doc.n_parcels)).accounts({}).rpc(), "SIG");
  assert.equal(sent, 1);
  process.env.COUNTYROOT_SKIP_VERIFY = "1";
  const errs = []; const orig = console.error; console.error = (s) => errs.push(s);
  try { assert.equal(await p.methods.postRoot(...args("22".repeat(32), 1)).accounts({}).rpc(), "SIG"); } finally { console.error = orig; delete process.env.COUNTYROOT_SKIP_VERIFY; }
  assert.equal(sent, 2); assert.match(errs.join(""), /WITHOUT PACKET VERIFICATION/);
  process.exitCode = 0;
});

const packet = process.env.COUNTYROOT_PACKET;
test("real packet passes", { skip: !packet && "set COUNTYROOT_PACKET" }, async () => {
  const r = await verifyPacket({ csvPath: packet });
  assert.ok(r.ok && r.nParcels > 0);
});

// End-to-end: run the real post script against a mock RPC; it must not send when verification fails.
function mockRpc() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const reqs = [].concat(JSON.parse(b));
      const answer = (q) => {
        calls.push(q.method);
        const ctx = { context: { slot: 1 } };
        switch (q.method) {
          case "getAccountInfo": return { ...ctx, value: null };
          case "getSignaturesForAddress": return [];
          case "getLatestBlockhash": return { ...ctx, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } };
          case "sendTransaction": return "5".repeat(88);
          case "getSignatureStatuses": return { ...ctx, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" }] };
          case "getBlockHeight": return 1;
          default: return null;
        }
      };
      const out = reqs.map((q) => ({ jsonrpc: "2.0", id: q.id, result: answer(q) }));
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(JSON.parse(b)) ? out : out[0]));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}
function runScript(script, env) {
  const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
  fs.mkdirSync(path.join(cwd, "target/idl"), { recursive: true });
  fs.copyFileSync(path.join(here, "test-fixtures/countyroot-idl-subset.json"), path.join(cwd, "target/idl/countyroot.json"));
  const kp = path.join(cwd, "kp.json"); fs.writeFileSync(kp, JSON.stringify([...Keypair.generate().secretKey]));
  return new Promise((r) => execFile("node", [path.join(repo, script)], { cwd, env: { ...process.env, ANCHOR_WALLET: kp, ...env } },
    (err, stdout, stderr) => r({ code: err ? err.code ?? 1 : 0, out: stdout + stderr })));
}
const scriptFor = packet && JSON.parse(fs.readFileSync(packet.replace(/\.csv$/, ".root.json"), "utf8"));
const postScript = scriptFor && fs.readdirSync(repo).find((f) => /^post_.*\.mjs$/.test(f) && fs.readFileSync(path.join(repo, f), "utf8").includes(`const fips = ${scriptFor.fips};`) && fs.readFileSync(path.join(repo, f), "utf8").includes(scriptFor.merkle_root));
test("real post script: tampered packet aborts before sendTransaction; good packet sends", { skip: !postScript && "set COUNTYROOT_PACKET to a packet with a post_*.mjs" }, async () => {
  const { srv, calls, url } = await mockRpc();
  try {
    const bad = path.join(tmp, "e2e-bad"); fs.mkdirSync(bad);
    const lines = fs.readFileSync(packet, "utf8").split("\n");
    const c = lines[1].split(","); c[1] = (Number(c[1]) + 1).toFixed(6); lines[1] = c.join(",");
    fs.writeFileSync(path.join(bad, path.basename(packet)), lines.join("\n"));
    fs.copyFileSync(packet.replace(/\.csv$/, ".root.json"), path.join(bad, path.basename(packet).replace(/\.csv$/, ".root.json")));
    let r = await runScript(postScript, { ANCHOR_PROVIDER_URL: url, COUNTYROOT_PACKETS_DIR: bad });
    assert.notEqual(r.code, 0); assert.match(r.out, /PREFLIGHT FAILED.*stored leaf/s);
    assert.ok(!calls.includes("sendTransaction"), calls.join(","));
    r = await runScript(postScript, { ANCHOR_PROVIDER_URL: url, COUNTYROOT_PACKETS_DIR: path.dirname(packet) });
    assert.match(r.out, /preflight OK/); assert.ok(calls.includes("sendTransaction"));
  } finally { srv.close(); }
});
