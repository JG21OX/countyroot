// node --test scripts/pii.test.mjs   (all names below are invented)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { piiReason, maskId, scanRows, loadAllowlist } from "./pii.mjs";
import { verifyPacket, VerifyError, loadSdk } from "./verify.mjs";

const allow = loadAllowlist();
const bad = {
  "jane.doe@example.com": "email", "LOT 4 contact jd@example.org": "email",
  "DOE JOHN LLC": "owner", "SMITH FAMILY TRUST": "owner", "DOE ETAL": "owner", "DOE ET UX": "owner", "ESTATE OF JANE DOE": "owner",
  "12-34 ACME INC": "owner", "DOE; JANE": "last_first", "Doe, Jane": "last_first",
  "JOHN DOE": "name", "Mary Ann Roe": "name", "ROE GERTRUDE Q": "name",
};
const good = [
  "01-20-09-00150", "25360-001-001-0000", "5792-032-98-8165", "02 06 14 0 002 009.0000", "000-0001-9",
  "CEMETERY", "COMMON AREA", "UNKNOWN OWNER", "Owner Unknow", "HARDY STREET", "Paul Revere Square Condos",
  "Vickie Palmer Condos", "Smith and Kelleys Condos", "SG-ROSA-A", "E-BLTH-COMMON", "THOMAS PLAINS COMBO",
  "LOT \"A\"", "OUTLOT B", "City Bett Pond & Drainage", "C & S RAILROAD", "Washington County", "PerezBndry", "Duncan",
  "1stBaptistOfZachary", "Bethleham MBC", "NOT ASSESSED", "<Null>", "S. MCCORD RD.",
];

test("rejects emails, owner keywords, LAST; FIRST and name-shaped IDs", () => {
  for (const [id, why] of Object.entries(bad)) assert.equal(piiReason(id, allow), why, id);
});
test("allows parcel numbers, places, plats, common areas and allowlisted IDs", () => {
  for (const id of good) assert.equal(piiReason(id, allow), null, id);
});
test("allowlist is exact and case-insensitive", () => {
  assert.equal(piiReason("thomas plains combo", allow), null);
  assert.equal(piiReason("THOMAS PLAINS", allow), "name");
});
test("masking never shows more than the first word", () => {
  assert.equal(maskId("DOE; JANE"), "DOE J***");
  assert.equal(maskId("MARY ANN ROE"), "MARY A*** R***");
  const hits = scanRows([{ parcel_id: "1-2" }, { parcel_id: "JOHN DOE" }], allow);
  assert.deepEqual(hits, [{ row: 3, reason: "name", masked: "JOHN D***" }]);
});
test("verifyPacket refuses a packet with a name-shaped ID and prints it masked; allow-pii overrides", async () => {
  const { leafHash, merkleRoot } = await loadSdk();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-pii-"));
  const rows = [["P-1", "1.000000", "43560.00"], ["JOHN DOE", "0.500000", "21780.00"], ["P-3", "2.000000", "87120.00"]];
  const leaves = rows.map(([p, a, s]) => leafHash(p, a, s));
  const csv = path.join(dir, "Test.ZZ.1.2026-10.csv");
  fs.writeFileSync(csv, ["parcel_id,acres,lot_sqft,leaf", ...rows.map((r, i) => `${r.join(",")},${leaves[i].toString("hex")}`)].join("\n") + "\n");
  fs.writeFileSync(csv.replace(/\.csv$/, ".root.json"), JSON.stringify({ label: "Test.ZZ", fips: 99001, epoch: 1, n_parcels: 3, merkle_root: merkleRoot(leaves).toString("hex") }));
  await assert.rejects(verifyPacket({ csvPath: csv }), (e) => e instanceof VerifyError && /row 3 name "JOHN D\*\*\*"/.test(e.message) && !e.message.includes("DOE"));
  assert.ok((await verifyPacket({ csvPath: csv, pii: false })).ok);
});
