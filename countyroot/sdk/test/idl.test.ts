import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ACCOUNT_DISCRIMINATORS } from "../src/accounts.js";
import { PROGRAM_ID } from "../src/constants.js";

const require = createRequire(import.meta.url);
test("bundled IDL matches the SDK's program ID and account discriminators", () => {
  const idl = JSON.parse(fs.readFileSync(require.resolve("@countyroot/sdk/idl.json"), "utf8"));
  assert.equal(idl.address, PROGRAM_ID.toBase58());
  for (const a of idl.accounts) assert.deepEqual(a.discriminator, [...(ACCOUNT_DISCRIMINATORS as any)[a.name]], a.name);
});
