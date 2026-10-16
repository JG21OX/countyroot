// npm test   (set COUNTYROOT_PACKET=<path/to/X.csv> to also check a real packet against its .root.json)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { PublicKey } from "@solana/web3.js";
import {
  parseEventsFromLogs, TruncatedLogsError, decodeCountyRoot, decodeConfig, ACCOUNT_DISCRIMINATORS,
  leafHash, leafPreimage, formatFixed, buildLevels, makeProof, verifyProof, merkleRoot, parsePacketCsv, packetLeaves,
  countyRootPda, configPda, pendingAuthorityPda, PROGRAM_ID, getTransactionEvents,
} from "../src/index.js";
import { main as cli } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, "../../test/fixtures/program-logs.json"), "utf8"));
const PID = PROGRAM_ID.toBase58();
const OTHER = "Fake1111111111111111111111111111111111111111";
const dataLine = (logs: string[]) => logs.find((l) => l.startsWith("Program data: "))!;

test("decodes every real event from program logs", () => {
  const want: Record<string, string> = { init: "ConfigInitialized", post: "RootPosted", update: "RootUpdated", retract: "RootRetracted",
    close: "RootClosed", pause: "PauseChanged", attestor: "AttestorChanged", propose: "AuthorityProposed",
    cancel: "AuthorityProposalCancelled", accept: "AuthorityChanged" };
  for (const [tx, name] of Object.entries(want)) {
    const r = parseEventsFromLogs(fx.tx[tx]);
    assert.equal(r.events.length, 1, tx); assert.equal(r.events[0].name, name);
  }
  const p = parseEventsFromLogs(fx.tx.post).events[0].data;
  assert.equal(p.fips, 12086); assert.equal(p.epoch, 2); assert.equal(p.nParcels, 119392n);
  assert.ok(p.merkleRoot.equals(Buffer.alloc(32, 4))); assert.equal(p.attestor.toBase58(), fx.keys.attestor);
  assert.equal(p.countyRoot.toBase58(), fx.keys.countyRoot); assert.equal(p.slot, 1234n); assert.equal(p.ts, 1760000000n);
  assert.equal(p.version, 1);
  const u = parseEventsFromLogs(fx.tx.update).events[0].data;
  assert.ok(u.oldRoot.equals(Buffer.alloc(32, 4)) && u.newRoot.equals(Buffer.alloc(32, 5)));
  const a = parseEventsFromLogs(fx.tx.accept).events[0].data;
  assert.equal(a.old.toBase58(), fx.keys.authority); assert.equal(a.new.toBase58(), fx.keys.newKey);
  assert.equal(countyRootPda(12086, 2).toBase58(), fx.keys.countyRoot);
});

test("forged event from another top-level program is ignored", () => {
  const forged = dataLine(fx.tx.post);
  const logs = [`Program ${OTHER} invoke [1]`, forged, `Program ${OTHER} success`];
  const r = parseEventsFromLogs(logs);
  assert.equal(r.events.length, 0); assert.equal(r.ignored, 1);
});

test("forged event from a CPI child of CountyRoot (nested frame) is ignored", () => {
  const forged = dataLine(fx.tx.post);
  const logs = [`Program ${PID} invoke [1]`, `Program ${OTHER} invoke [2]`, forged, `Program ${OTHER} success`, `Program ${PID} success`];
  assert.equal(parseEventsFromLogs(logs).events.length, 0);
});

test("forged event in a program that CPIs into CountyRoot: only the CountyRoot frame counts", () => {
  const real = fx.tx.post.map((l: string) => l.replace(" invoke [1]", " invoke [2]").replace(" invoke [2]", (m: string, o: number, s: string) => s.startsWith("Program 1111") ? " invoke [3]" : m));
  const logs = [`Program ${OTHER} invoke [1]`, dataLine(fx.tx.retract), ...real, dataLine(fx.tx.close), `Program ${OTHER} success`];
  const r = parseEventsFromLogs(logs);
  assert.deepEqual(r.events.map((e) => e.name), ["RootPosted"]); assert.equal(r.ignored, 2);
});

test("malformed frame structure throws", () => {
  assert.throws(() => parseEventsFromLogs([`Program ${PID} invoke [2]`]), /depth/);
  assert.throws(() => parseEventsFromLogs([`Program ${PID} invoke [1]`, `Program ${OTHER} success`]), /exited/);
});

test("truncated logs are refused by default and flagged on request", () => {
  const logs = [...fx.tx.post.slice(0, 5), "Log truncated"];
  assert.throws(() => parseEventsFromLogs(logs), TruncatedLogsError);
  const r = parseEventsFromLogs(logs, { onTruncated: "flag" });
  assert.equal(r.truncated, true); assert.equal(r.events.length, 1);
});

test("getTransactionEvents: finalized by default, refuses failed tx, cross-checks state", async () => {
  let seen: any;
  const acct = Buffer.concat([ACCOUNT_DISCRIMINATORS.CountyRoot, Buffer.from(new Uint32Array([12086, 2]).buffer),
    Buffer.from(new BigUint64Array([119392n]).buffer), Buffer.alloc(32, 4), Buffer.alloc(32, 0x1b), Buffer.from([1]),
    Buffer.alloc(8), Buffer.from([255, 1])]);
  const conn: any = {
    getTransaction: async (_s: string, o: any) => { seen = o.commitment; return { slot: 9, meta: { err: null, logMessages: fx.tx.post } }; },
    getAccountInfo: async () => ({ owner: PROGRAM_ID, data: acct }),
  };
  const r = await getTransactionEvents(conn, "sig", { crossCheck: true });
  assert.equal(seen, "finalized"); assert.equal(r.events[0].name, "RootPosted");
  assert.deepEqual(r.crossCheck!.map((c) => c.ok), [true]);
  conn.getTransaction = async () => ({ slot: 9, meta: { err: { InstructionError: [0, "x"] }, logMessages: fx.tx.post } });
  await assert.rejects(getTransactionEvents(conn, "sig"), /failed/);
});

test("v0 (98-byte) and v1 (99-byte) CountyRoot decoding", () => {
  const body = Buffer.concat([ACCOUNT_DISCRIMINATORS.CountyRoot, Buffer.from([0x36, 0x2f, 0, 0, 1, 0, 0, 0]),
    Buffer.from(new BigUint64Array([10n]).buffer), Buffer.alloc(32, 3), Buffer.alloc(32, 4), Buffer.from([2]),
    Buffer.from(new BigInt64Array([5n]).buffer), Buffer.from([254])]);
  assert.equal(body.length, 98);
  const v0 = decodeCountyRoot(body);
  assert.equal(v0.version, 0); assert.equal(v0.fips, 12086); assert.equal(v0.epoch, 1); assert.equal(v0.status, 2);
  const v1 = decodeCountyRoot(Buffer.concat([body, Buffer.from([1])]));
  assert.equal(v1.version, 1); assert.ok(v1.merkleRoot.equals(Buffer.alloc(32, 3)));
  assert.throws(() => decodeCountyRoot(Buffer.alloc(98)), /not a CountyRoot/);
  const k = new PublicKey(Buffer.alloc(32, 7));
  const cfg = decodeConfig(Buffer.concat([ACCOUNT_DISCRIMINATORS.Config, k.toBuffer(), k.toBuffer(), Buffer.from([1, 9])]));
  assert.ok(cfg.paused && cfg.authority.equals(k));
  assert.equal(configPda().toBase58(), "GuqjjRFrECCQKYkawmw6mQkWvxcKDecEFuPX1tjxGMkU");
  assert.ok(pendingAuthorityPda() instanceof PublicKey);
});

test("leaf formatting is half-up like the packet builder", () => {
  assert.equal(formatFixed("1.11", 6), "1.110000");
  assert.equal(formatFixed("0.0000005", 6), "0.000001");
  assert.equal(formatFixed("48351.605", 2), "48351.61");
  assert.equal(formatFixed(2.675, 2), "2.68"); // binary float would give 2.67 with toFixed
  assert.equal(leafPreimage("3069010040160", "1.11", "48351.6"), "3069010040160|1.110000|48351.60");
  assert.equal(leafHash("3069010040160", "1.110000", "48351.60").toString("hex"),
    "9dcebf178549d5f7eb9073b7a1fd931a89786014e5f6114bc00417b1df1933bb");
});

test("proofs verify for every index on odd/even trees; tampering fails", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => leafHash(`P${i}`, i, i * 10));
    const levels = buildLevels(leaves), root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const p = makeProof(levels, i);
      assert.ok(verifyProof(p, root), `n=${n} i=${i}`);
      const bad = { ...p, leaf: leafHash(`P${i}`, i, i * 10 + 1).toString("hex") };
      assert.ok(!verifyProof(bad, root));
      if (n > 1) assert.ok(!verifyProof({ ...p, index: (i + 1) % n }, root) || n === 1);
    }
  }
});

const packet = process.env.COUNTYROOT_PACKET;
test("real packet: recomputed root equals root.json; CLI verifies offline; tampered leaf fails", { skip: !packet && "set COUNTYROOT_PACKET" }, async () => {
  const rootPath = packet!.replace(/\.csv$/, ".root.json");
  const doc = JSON.parse(fs.readFileSync(rootPath, "utf8"));
  const rows = parsePacketCsv(fs.readFileSync(packet!, "utf8"));
  assert.equal(rows.length, doc.n_parcels);
  const levels = buildLevels(packetLeaves(rows));
  assert.equal(levels[levels.length - 1][0].toString("hex"), doc.merkle_root);
  const mid = Math.floor(rows.length / 2);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-sdk-"));
  const proofPath = path.join(tmp, "proof.json");
  const out: string[] = [];
  assert.equal(await cli(["proof", "--csv", packet!, "--parcel", rows[mid].parcel_id, "--out", proofPath], (s) => out.push(s)), 0);
  assert.equal(await cli(["verify", "--root", rootPath, "--proof", proofPath, "--fips", String(doc.fips), "--epoch", String(doc.epoch), "--parcel", rows[mid].parcel_id], (s) => out.push(s)), 0);
  assert.ok(out.includes("VERIFIED"));
  const p = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  fs.writeFileSync(proofPath, JSON.stringify({ ...p, acres: formatFixed(Number(p.acres) + 0.000001, 6) }));
  assert.equal(await cli(["verify", "--root", rootPath, "--proof", proofPath], () => {}), 1);
  fs.writeFileSync(proofPath, JSON.stringify({ ...p, leaf: "00".repeat(32), parcel_id: undefined }));
  assert.equal(await cli(["verify", "--root", rootPath, "--proof", proofPath], () => {}), 1);
});
