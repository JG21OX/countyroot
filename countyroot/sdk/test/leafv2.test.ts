// Leaf format v2 tests. Real-packet checks run when the packets are present (COUNTYROOT_PACKETS_DIR, default /workspace/countyroot).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  toUnits, unitsToDecimal, keyV2, canonicalRowsV2, buildTreeV2, makeProofV2, verifyProofV2, leafHashV2, nodeHashV2, rootHashV2,
  makeAbsenceProofV2, verifyAbsenceV2, findKeyV2, leafPreimageV2, SCHEMA_V2, SCHEMA_V1, parsePacketCsv, NOT_PROVIDED, RowV2,
} from "../src/index.js";

const P = process.env.COUNTYROOT_PACKETS_DIR || "/workspace/countyroot";
const pk = (...p: string[]) => path.join(P, ...p);
const rowsOf = (data: [string, string, string][]) => data.map(([parcel_id, acres, lot_sqft]) => ({ parcel_id, acres, lot_sqft }));

test("numbers: exact integer units, half-up, no text-format drift (18089 == 18089.00 == 18089.004)", () => {
  assert.equal(toUnits("18089", 2), 1808900n);
  assert.equal(toUnits("18089.00", 2), 1808900n);
  assert.equal(toUnits("18089.004", 2), 1808900n);
  assert.equal(toUnits("18089.005", 2), 1808901n);
  assert.equal(toUnits("0.415276", 6), 415276n);
  assert.equal(toUnits(".5", 6), 500000n);
  assert.equal(toUnits("0.1234565", 6), 123457n);
  assert.equal(toUnits("", 6), NOT_PROVIDED);
  assert.equal(unitsToDecimal(1808900n, 2), "18089.00");
  for (const bad of ["-1", "1e3", "abc", "1,000", "."]) assert.throws(() => toUnits(bad, 2), bad);
  const a = leafHashV2(48453, { id: "0", occ: 0, acresMicro: toUnits("0.415276", 6), sqftCenti: toUnits("18089", 2) });
  const b = leafHashV2(48453, { id: "0", occ: 0, acresMicro: toUnits("0.415276", 6), sqftCenti: toUnits("18089.00", 2) });
  assert.ok(a.equals(b));
});

test("keys: normalized key (case, spaces, dots, dashes, leading zeros); IDs must be printable ASCII", () => {
  assert.equal(keyV2("0240-050.817"), "240050817");
  assert.equal(keyV2("12601-01-01"), "126010101");
  assert.equal(keyV2("14 30 01 01117 000 0001"), "143001011170000001");
  assert.equal(keyV2("000"), "0");
  assert.equal(keyV2("r100119"), "R100119");
  assert.throws(() => leafPreimageV2(1, { id: "café", occ: 0, acresMicro: 0n, sqftCenti: 0n }));
  assert.throws(() => leafPreimageV2(1, { id: " 12", occ: 0, acresMicro: 0n, sqftCenti: 0n }));
});

test("order and duplicates: CSV order never matters; repeated IDs get occ by value; every row is provable", () => {
  const data: [string, string, string][] = [["B-2", "1.0", "43560"], ["a1", "2.5", "1"], ["B-2", "0.5", "21780"], ["0A1", "9", "9"], ["B-2", "0.5", "21780.00"], ["c", "1", "1"]];
  const t1 = buildTreeV2(12086, 3, canonicalRowsV2(rowsOf(data)));
  const t2 = buildTreeV2(12086, 3, canonicalRowsV2(rowsOf([...data].reverse())));
  assert.ok(t1.root.equals(t2.root), "same rows in another order give the same root");
  const b2 = t1.rows.filter((r) => r.id === "B-2");
  assert.deepEqual(b2.map((r) => [r.occ, r.acresMicro]), [[0, 500000n], [1, 500000n], [2, 1000000n]]);
  // "0A1" and "a1" share key "A1" but are different IDs: both kept, ordered by id bytes
  assert.deepEqual(t1.rows.slice(0, 2).map((r) => r.id), ["0A1", "a1"]);
  for (let i = 0; i < t1.rows.length; i++) assert.ok(verifyProofV2(makeProofV2(t1, i), t1.root), `row ${i}`);
});

test("non-membership: adjacent-pair proofs for gaps, before the first and after the last key; forgeries fail", () => {
  const t = buildTreeV2(48317, 2, canonicalRowsV2(rowsOf([["100", "1", "1"], ["200", "1", "1"], ["300", "1", "1"], ["400", "1", "1"], ["500", "1", "1"]])));
  for (const q of ["150", "0150", "1-5-0", "050", "999", "ZZZ"]) {
    const a = makeAbsenceProofV2(t, q);
    assert.ok(verifyAbsenceV2(a, t.root, 48317, 2), q);
  }
  assert.throws(() => makeAbsenceProofV2(t, "0200"), /present/);
  // forged: non-adjacent neighbours (skip over 300) must fail
  const forged = { version: 2 as const, query: "300", key: "300", left: makeProofV2(t, 1), right: makeProofV2(t, 3) };
  assert.equal(verifyAbsenceV2(forged, t.root, 48317, 2), false);
  // forged: claiming "after the last" while the left leaf is not the last
  assert.equal(verifyAbsenceV2({ version: 2, query: "999", key: "999", left: makeProofV2(t, 3), right: null }, t.root, 48317, 2), false);
  // proofs from another epoch or county are rejected
  const a = makeAbsenceProofV2(t, "150");
  assert.equal(verifyAbsenceV2(a, t.root, 48317, 3), false);
});

test("domain separation: a leaf, proof or root from one county/epoch is useless in another", () => {
  const data = rowsOf([["1", "1", "1"], ["2", "2", "2"], ["3", "3", "3"]]);
  const ta = buildTreeV2(48453, 3, canonicalRowsV2(data)), tb = buildTreeV2(12086, 3, canonicalRowsV2(data)), tc = buildTreeV2(48453, 4, canonicalRowsV2(data));
  assert.ok(!ta.levels[0][0].equals(tb.levels[0][0]), "leaves bind fips");
  assert.ok(ta.levels[0][0].equals(tc.levels[0][0]), "leaves do NOT bind epoch (so unchanged parcels keep their leaf across epochs)");
  assert.ok(!ta.root.equals(tc.root), "roots bind epoch");
  const p = makeProofV2(ta, 1);
  assert.equal(verifyProofV2(p, tb.root), false, "cross-county replay");
  assert.equal(verifyProofV2({ ...p, fips: 12086 }, tb.root), false, "relabelled cross-county replay");
  assert.equal(verifyProofV2(p, tc.root), false, "cross-epoch replay");
  assert.equal(verifyProofV2({ ...p, epoch: 4 }, tc.root), true, "same data, other epoch: the proof is only valid with that epoch's own root");
  // count is bound: a phantom extra leaf (v1's duplicate-last-node issue) cannot verify
  assert.equal(verifyProofV2({ ...makeProofV2(ta, 2), nLeaves: 4, index: 3 }, ta.root), false);
  // leaf vs node prefixes: an inner node can't be passed off as a leaf
  const inner = nodeHashV2(ta.levels[0][0], ta.levels[0][1]);
  assert.ok(!inner.equals(leafHashV2(48453, ta.rows[0])));
  assert.ok(!rootHashV2(48453, 3, 3, ta.top).equals(ta.top));
  assert.notEqual(SCHEMA_V2.toString("hex"), SCHEMA_V1.toString("hex"));
});

test("tampering: changing any field, the occ, or a sibling breaks the proof", () => {
  const t = buildTreeV2(1, 1, canonicalRowsV2(rowsOf([["X", "1.000001", "43.56"], ["X", "1.000001", "43.56"], ["Y", "2", "3"]])));
  const p = makeProofV2(t, 1);
  assert.ok(verifyProofV2(p, t.root));
  assert.equal(verifyProofV2({ ...p, row: { ...p.row, acres_micro: "1000002" } }, t.root), false);
  assert.equal(verifyProofV2({ ...p, row: { ...p.row, occ: 0 } }, t.root), false);
  assert.equal(verifyProofV2({ ...p, row: { ...p.row, id: "x" } }, t.root), false);
  assert.equal(verifyProofV2({ ...p, siblings: p.siblings.map((s, i) => (i ? s : "00".repeat(32))) }, t.root), false);
  assert.equal(verifyProofV2({ ...p, siblings: [...p.siblings, "00".repeat(32)] }, t.root), false);
});

const travis1 = pk("Travis.TX.1.2026-09.csv"), travis2 = pk("Travis.TX.2.2026-10.csv");
test("Travis epoch 1 vs 2: identical v2 leaves for every unchanged parcel (v1 leaves all differ)", { skip: !(fs.existsSync(travis1) && fs.existsSync(travis2)) && "Travis packets not present" }, () => {
  const r1 = parsePacketCsv(fs.readFileSync(travis1, "utf8")), r2 = parsePacketCsv(fs.readFileSync(travis2, "utf8"));
  const t1 = buildTreeV2(48453, 3, canonicalRowsV2(r1)), t2 = buildTreeV2(48453, 3, canonicalRowsV2(r2));
  assert.equal(t1.rows.length, 386068); assert.equal(t2.rows.length, 386068);
  let same = 0; for (let i = 0; i < t1.rows.length; i++) if (t1.levels[0][i].equals(t2.levels[0][i])) same++;
  assert.equal(same, 386068);
  assert.ok(t1.root.equals(t2.root), "same data -> same v2 root for the same epoch");
  const v1same = r1.filter((r, i) => r.leaf === r2[i].leaf).length;
  assert.equal(v1same, 0, "under v1 the text formatting changed every leaf");
});

const miami = pk("MiamiDade.FL.2.2026-10.csv");
test("Miami-Dade: 1,193 repeated-ID rows handled deterministically; all 87 rows of 3069340218780 prove; absence works", { skip: !fs.existsSync(miami) && "Miami-Dade packet not present" }, () => {
  const rows = parsePacketCsv(fs.readFileSync(miami, "utf8"));
  const t = buildTreeV2(12086, 3, canonicalRowsV2(rows));
  assert.equal(t.rows.filter((r) => r.occ > 0).length, 1193);
  const { lo, hi } = findKeyV2(t, "3069340218780");
  assert.equal(hi - lo, 87);
  for (let i = lo; i < hi; i++) { assert.equal(t.rows[i].occ, i - lo); assert.ok(verifyProofV2(makeProofV2(t, i), t.root)); }
  const shuffled = rows.slice().reverse();
  assert.ok(buildTreeV2(12086, 3, canonicalRowsV2(shuffled)).root.equals(t.root), "row order in the CSV doesn't matter");
  const a = makeAbsenceProofV2(t, "3069340218781");
  assert.ok(verifyAbsenceV2(a, t.root, 12086, 3));
});
