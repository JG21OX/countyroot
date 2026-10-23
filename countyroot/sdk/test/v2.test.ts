// SDK 0.3.0: v2 account tail, CountyHead, new events, fetchLatest, verifyManifest.
// Fixtures in test/fixtures/v2.json are real bytes/logs from the program under litesvm
// (programs/countyroot/tests/fixtures.rs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeCountyRoot, decodeCountyHead, parseEventsFromLogs, countyHeadPda, countyRootPda, fetchLatest, getTransactionEvents,
  verifyManifest, canonicalManifest, manifestSha256, STATUS_ACTIVE, STATUS_RETRACTED, STATUS_SUPERSEDED, REASON, PROGRAM_ID,
  type CountyRoot,
} from "../src/index.js";
import { checkStatus, statusText } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, "../../test/fixtures/v2.json"), "utf8"));
const B = (k: string) => Buffer.from(fx[k], "base64");
const fill = (b: number) => Buffer.alloc(32, b);

test("decodes v2 active / superseded / retracted roots", () => {
  const a = decodeCountyRoot(B("active"));
  assert.equal(a.version, 2); assert.equal(a.status, STATUS_ACTIVE); assert.equal(a.epoch, 2);
  assert.deepEqual(a.provenance!.manifestSha256, fill(2)); assert.deepEqual(a.provenance!.sourceSha256, fill(3));
  assert.deepEqual(a.provenance!.packetSha256, fill(4)); assert.equal(a.provenance!.fetchedAt, 1_760_100_000n);
  assert.equal(a.provenance!.dataAsOf, 1_760_000_000n); assert.equal(a.provenance!.postedSlot, 2000n);
  assert.equal(a.provenance!.leafVersion, 2); assert.equal(a.provenance!.migrated, false);
  const s = decodeCountyRoot(B("superseded"));
  assert.equal(s.status, STATUS_SUPERSEDED); assert.equal(s.provenance!.supersededBy, 2);
  assert.equal(s.provenance!.retractReason, REASON.SUPERSEDED); assert.equal(s.provenance!.statusChangedAt, 1_760_300_000n);
  const r = decodeCountyRoot(B("retracted"));
  assert.equal(r.status, STATUS_RETRACTED); assert.equal(r.provenance!.retractReason, REASON.PII);
});

test("legacy and migrated roots", () => {
  const l = decodeCountyRoot(B("legacy99"));
  assert.equal(l.version, 1); assert.equal(l.provenance, null);
  const m = decodeCountyRoot(B("migrated"));
  assert.equal(m.version, 2); assert.equal(m.provenance!.migrated, true);
  assert.deepEqual(m.provenance!.sourceSha256, Buffer.alloc(32)); assert.equal(m.provenance!.postedSlot, 0n);
  // body identical to legacy
  assert.deepEqual(B("migrated").subarray(0, 98), B("legacy99").subarray(0, 98));
  const { provenance, version, ...lb } = l; const { provenance: _p, version: _v, ...mb } = m;
  assert.deepEqual(lb, mb);
});

test("decodes CountyHead", () => {
  const h = decodeCountyHead(B("headActive"));
  assert.deepEqual([h.fips, h.latestEpoch, h.latestActiveEpoch, h.nEpochs], [48453, 2, 2, 2]);
  const n = decodeCountyHead(B("headNone"));
  assert.deepEqual([n.latestEpoch, n.latestActiveEpoch], [2, 0]);
  assert.throws(() => decodeCountyHead(B("active")), /not a CountyHead/);
});

test("decodes new events from real logs", () => {
  const p1 = parseEventsFromLogs(fx.logsPost1).events.map((e) => e.name);
  assert.deepEqual(p1, ["RootPostedV2", "HeadUpdated"]);
  const p2 = parseEventsFromLogs(fx.logsPost2).events;
  assert.deepEqual(p2.map((e) => e.name).sort(), ["HeadUpdated", "RootPostedV2", "RootSuperseded"]);
  const sup = p2.find((e) => e.name === "RootSuperseded")!.data;
  assert.equal(sup.epoch, 1); assert.equal(sup.supersededBy, 2);
  const pv = p2.find((e) => e.name === "RootPostedV2")!.data;
  assert.equal(pv.supersededEpoch, 1); assert.deepEqual(pv.manifestSha256, fill(2)); assert.equal(pv.version, 2);
  const r = parseEventsFromLogs(fx.logsRetract).events;
  const rv = r.find((e) => e.name === "RootRetractedV2")!.data;
  assert.equal(rv.reason, REASON.PII); assert.equal(rv.prevStatus, STATUS_ACTIVE);
  assert.equal(r.find((e) => e.name === "HeadUpdated")!.data.latestActiveEpoch, 0);
});

test("countyHeadPda", () => {
  const want = PublicKey.findProgramAddressSync([Buffer.from("county_head"), Buffer.from([0x45, 0xbd, 0, 0])], PROGRAM_ID)[0];
  assert.ok(countyHeadPda(48453).equals(want));
  assert.throws(() => countyHeadPda(-1));
});

function fakeConn(accounts: Record<string, Buffer>): Connection {
  return {
    async getAccountInfo(k: PublicKey) {
      const d = accounts[k.toBase58()];
      return d ? { data: d, owner: PROGRAM_ID, lamports: 1, executable: false } : null;
    },
  } as any;
}

test("fetchLatest follows latest_active_epoch; null root after the latest is retracted", async () => {
  const conn = fakeConn({ [countyHeadPda(48453).toBase58()]: B("headActive"), [countyRootPda(48453, 2).toBase58()]: B("active") });
  const l = await fetchLatest(conn, 48453);
  assert.equal(l!.epoch, 2); assert.equal(l!.root!.status, STATUS_ACTIVE);
  const conn2 = fakeConn({ [countyHeadPda(48453).toBase58()]: B("headNone"), [countyRootPda(48453, 2).toBase58()]: B("retracted") });
  const n = await fetchLatest(conn2, 48453);
  assert.equal(n!.epoch, 0); assert.equal(n!.root, null);
  assert.equal(await fetchLatest(fakeConn({}), 48453), null);
  // head pointing at a non-active root is an error, not a silent answer
  const conn3 = fakeConn({ [countyHeadPda(48453).toBase58()]: B("headActive"), [countyRootPda(48453, 2).toBase58()]: B("retracted") });
  await assert.rejects(fetchLatest(conn3, 48453), /its status is 2/);
});

function manifestFor(root: CountyRoot, extra: Record<string, any> = {}) {
  const p = root.provenance!;
  return {
    county_label: "Test County, TX", fips: root.fips, epoch: root.epoch, source_url: "https://example.gov/parcels.zip",
    source_query: null, source_format: "shapefile", fetched_at: new Date(Number(p.fetchedAt) * 1000).toISOString().replace(".000Z", "Z"),
    source_sha256: p.sourceSha256.equals(Buffer.alloc(32)) ? null : p.sourceSha256.toString("hex"), source_record_count: 42,
    data_as_of: new Date(Number(p.dataAsOf) * 1000).toISOString().replace(".000Z", "Z"), builder_commit: "abc1234", recipe: "v2",
    leaf_version: p.leafVersion, schema_sha256: root.schema.toString("hex"), packet_sha256: p.packetSha256.toString("hex"),
    pii_scan: { version: 1, result: "pass" }, n_parcels: Number(root.nParcels), merkle_root: root.merkleRoot.toString("hex"),
    supersedes_epoch: root.epoch > 1 ? root.epoch - 1 : null, reason: null, ...extra,
  };
}
/** Build a manifest, then splice its hash into the account so the pair is consistent. */
function pair(key: string, extra: Record<string, any> = {}) {
  const acct = Buffer.from(B(key));
  const root = decodeCountyRoot(acct);
  const bytes = canonicalManifest(manifestFor(root, extra));
  manifestSha256(bytes).copy(acct, 99);
  return { bytes, root: decodeCountyRoot(acct) };
}

test("canonicalManifest: sorted keys, no whitespace, trailing LF", () => {
  assert.equal(canonicalManifest({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }).toString(), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}\n');
});

test("verifyManifest: matching manifest passes; any change fails", () => {
  const { bytes, root } = pair("active");
  assert.deepEqual(verifyManifest(bytes, root).problems, []);
  const tampered = Buffer.from(bytes.toString().replace('"recipe":"v2"', '"recipe":"v3"'));
  assert.match(verifyManifest(tampered, root).problems.join(), /manifest_sha256/);
  const pretty = Buffer.from(JSON.stringify(JSON.parse(bytes.toString()), null, 2));
  assert.match(verifyManifest(pretty, root).problems.join(), /canonical/);
  const wrong = pair("active", { n_parcels: 41 });
  assert.match(verifyManifest(wrong.bytes, wrong.root).problems.join(), /n_parcels/);
  const extra = pair("active", { owner_name: "x" });
  assert.match(verifyManifest(extra.bytes, extra.root).problems.join(), /unexpected manifest keys: owner_name/);
  assert.match(verifyManifest(bytes, decodeCountyRoot(B("legacy99"))).problems.join(), /no on-chain manifest hash/);
});

test("verifyManifest: migrated root with null source_sha256", () => {
  const { bytes, root } = pair("migrated");
  assert.equal(JSON.parse(bytes.toString()).source_sha256, null);
  assert.deepEqual(verifyManifest(bytes, root).problems, []);
});

test("getTransactionEvents crossCheck understands v2 events", async () => {
  const accounts: Record<string, Buffer> = {
    [countyRootPda(48453, 1).toBase58()]: B("superseded"), [countyRootPda(48453, 2).toBase58()]: B("active"),
    [countyHeadPda(48453).toBase58()]: B("headActive"),
  };
  const conn = { ...fakeConn(accounts), async getTransaction() { return { slot: 9, meta: { err: null, logMessages: fx.logsPost2 } }; } } as any;
  const r = await getTransactionEvents(conn, "sig", { crossCheck: true });
  assert.equal(r.crossCheck!.length, 3);
  assert.ok(r.crossCheck!.every((c) => c.ok), JSON.stringify(r.crossCheck));
  assert.match(r.crossCheck!.find((c) => c.event === "RootSuperseded")!.note, /superseded by epoch 2/);
});

test("cli: SUPERSEDED warns but passes; RETRACTED and unknown fail", () => {
  const out: string[] = [];
  assert.equal(checkStatus(decodeCountyRoot(B("superseded")), (x) => out.push(x)), true);
  assert.match(out[0], /^WARNING: not the latest epoch: superseded by epoch 2/);
  assert.equal(statusText(decodeCountyRoot(B("superseded"))), "SUPERSEDED by epoch 2");
  assert.equal(checkStatus(decodeCountyRoot(B("active")), (x) => out.push(x)), true);
  assert.equal(checkStatus(decodeCountyRoot(B("retracted")), (x) => out.push(x)), false);
  assert.equal(statusText(decodeCountyRoot(B("retracted"))), "RETRACTED (pii)");
  const odd = { ...decodeCountyRoot(B("active")), status: 9 };
  assert.equal(checkStatus(odd, (x) => out.push(x)), false);
});
