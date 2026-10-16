// node --test scripts/set_attestor.test.mjs  (mocked connection; no network, no real wallets)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { run, parseArgs, parseConfig, checkRotation, setAttestorIx, CONFIG_PDA, PROGRAM_ID } from "./set_attestor.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-test-"));
const writeKp = (kp, name) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify([...kp.secretKey])); return p; };
const disc = (s) => createHash("sha256").update(s).digest().subarray(0, 8);
const configData = (authority, attestor, paused = false) =>
  Buffer.concat([disc("account:Config"), authority.toBuffer(), attestor.toBuffer(), Buffer.from([paused ? 1 : 0, 255])]);

function mockConn(state, { simErr = null } = {}) {
  const calls = { sim: 0, send: 0 };
  return {
    calls,
    getAccountInfo: async (k) => (k.equals(CONFIG_PDA) ? { owner: PROGRAM_ID, data: configData(state.authority, state.attestor, state.paused) } : null),
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    simulateTransaction: async () => { calls.sim++; return { value: { err: simErr, logs: [] } }; },
    sendRawTransaction: async (raw) => {
      calls.send++;
      const ixData = raw.subarray(raw.length - 40); // last ix data = disc(8) + pubkey(32)
      state.attestor = new PublicKey(ixData.subarray(8));
      return "SIG_TEST";
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
}

const auth = Keypair.generate(), oldAtt = Keypair.generate(), newAtt = Keypair.generate();
const authPath = writeKp(auth, "auth.json"), newPath = writeKp(newAtt, "new.json");

test("parses config layout", () => {
  const c = parseConfig(configData(auth.publicKey, oldAtt.publicKey, true));
  assert.ok(c.authority.equals(auth.publicKey) && c.attestor.equals(oldAtt.publicKey) && c.paused);
  assert.throws(() => parseConfig(Buffer.alloc(74)), /not a CountyRoot Config/);
});

test("instruction encoding matches program", () => {
  const ix = setAttestorIx(auth.publicKey, newAtt.publicKey);
  assert.deepEqual(ix.data.subarray(0, 8), disc("global:set_attestor"));
  assert.ok(new PublicKey(ix.data.subarray(8)).equals(newAtt.publicKey));
  assert.ok(ix.keys[0].pubkey.equals(CONFIG_PDA) && ix.keys[0].isWritable && !ix.keys[0].isSigner);
  assert.ok(ix.keys[1].pubkey.equals(auth.publicKey) && ix.keys[1].isSigner);
});

test("checks refuse non-authority, zero and same key", () => {
  const cfg = { authority: auth.publicKey, attestor: oldAtt.publicKey };
  assert.equal(checkRotation(cfg, auth.publicKey, newAtt.publicKey).length, 0);
  assert.match(checkRotation(cfg, oldAtt.publicKey, newAtt.publicKey)[0], /not config.authority/);
  assert.match(checkRotation(cfg, auth.publicKey, PublicKey.default)[0], /zero/);
  assert.match(checkRotation(cfg, auth.publicKey, oldAtt.publicKey)[0], /already/);
  assert.throws(() => parseArgs([]), /--new/);
});

test("dry run simulates and does not send; accepts pubkey or keypair file", async () => {
  for (const nv of [newAtt.publicKey.toBase58(), newPath]) {
    const st = { authority: auth.publicKey, attestor: oldAtt.publicKey, paused: true };
    const c = mockConn(st); const out = [];
    const r = await run(["--new", nv, "--authority", authPath], { connection: c, log: (s) => out.push(s) });
    assert.ok(r.ok && r.dryRun); assert.equal(c.calls.sim, 1); assert.equal(c.calls.send, 0);
    assert.ok(st.attestor.equals(oldAtt.publicKey));
    assert.ok(out.some((l) => l.includes("paused         true")));
  }
});

test("--send submits and confirms the change", async () => {
  const st = { authority: auth.publicKey, attestor: oldAtt.publicKey, paused: false };
  const c = mockConn(st); const out = [];
  const r = await run(["--new", newPath, "--authority", authPath, "--send"], { connection: c, log: (s) => out.push(s) });
  assert.ok(r.ok); assert.equal(r.sig, "SIG_TEST"); assert.equal(c.calls.send, 1);
  assert.ok(st.attestor.equals(newAtt.publicKey));
  assert.ok(out.some((l) => l.includes("signature SIG_TEST")));
});

test("refusals never simulate or send", async () => {
  const st = { authority: oldAtt.publicKey, attestor: oldAtt.publicKey, paused: false };
  const c = mockConn(st); const out = [];
  const r = await run(["--new", newPath, "--authority", authPath, "--send"], { connection: c, log: (s) => out.push(s) });
  assert.ok(!r.ok); assert.equal(c.calls.sim + c.calls.send, 0);
});

test("failed simulation is reported", async () => {
  const st = { authority: auth.publicKey, attestor: oldAtt.publicKey, paused: false };
  const c = mockConn(st, { simErr: { InstructionError: [0, { Custom: 6005 }] } });
  const r = await run(["--new", newPath, "--authority", authPath], { connection: c, log: () => {} });
  assert.ok(!r.ok); assert.equal(c.calls.send, 0);
});

test("never prints secret key bytes", async () => {
  const st = { authority: auth.publicKey, attestor: oldAtt.publicKey, paused: false };
  const out = [];
  await run(["--new", newPath, "--authority", authPath, "--send"], { connection: mockConn(st), log: (s) => out.push(s) });
  const all = out.join("\n");
  for (const kp of [auth, newAtt]) {
    assert.ok(!all.includes(Buffer.from(kp.secretKey).toString("hex")));
    assert.ok(!all.includes(JSON.stringify([...kp.secretKey]).slice(1, 40)));
  }
});
