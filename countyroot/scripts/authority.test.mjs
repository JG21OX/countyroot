// node --test scripts/authority.test.mjs  (mocked connection; no network, no real wallets)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { CONFIG_PDA, PENDING_PDA, PROGRAM_ID, proposeIx, acceptIx, cancelIx } from "./authority_lib.mjs";
import { run as propose } from "./propose_authority.mjs";
import { run as accept } from "./accept_authority.mjs";
import { run as cancel } from "./cancel_authority.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cr-auth-"));
const writeKp = (kp, n) => { const p = path.join(tmp, n); fs.writeFileSync(p, JSON.stringify([...kp.secretKey])); return p; };
const disc = (s) => createHash("sha256").update(s).digest().subarray(0, 8);
const cfgData = (s) => Buffer.concat([disc("account:Config"), s.authority.toBuffer(), s.attestor.toBuffer(), Buffer.from([s.paused ? 1 : 0, 255])]);
const pendData = (p) => Buffer.concat([disc("account:PendingAuthority"), p.proposed.toBuffer(), p.proposer.toBuffer(), Buffer.from([254])]);

// A tiny fake chain that applies the three instructions to state.
function mockConn(st) {
  const calls = { sim: 0, send: 0 };
  return {
    calls,
    getAccountInfo: async (k) => {
      if (k.equals(CONFIG_PDA)) return { owner: PROGRAM_ID, lamports: 1, data: cfgData(st) };
      if (k.equals(PENDING_PDA) && st.pending) return { owner: PROGRAM_ID, lamports: 1, data: pendData(st.pending) };
      return null;
    },
    getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
    simulateTransaction: async () => { calls.sim++; return { value: { err: null, logs: [] } }; },
    sendRawTransaction: async (raw) => {
      calls.send++;
      const ix = Transaction.from(raw).instructions[0];
      const d = ix.data.subarray(0, 8);
      if (d.equals(disc("global:propose_authority"))) st.pending = { proposed: new PublicKey(ix.data.subarray(8)), proposer: ix.keys[2].pubkey };
      else if (d.equals(disc("global:accept_authority"))) { st.authority = ix.keys[3].pubkey; st.pending = null; }
      else if (d.equals(disc("global:cancel_authority"))) st.pending = null;
      return "SIG_TEST";
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
}

const auth = Keypair.generate(), att = Keypair.generate(), nw = Keypair.generate(), rogue = Keypair.generate();
const authP = writeKp(auth, "auth.json"), newP = writeKp(nw, "new.json"), rogueP = writeKp(rogue, "rogue.json");
const fresh = () => ({ authority: auth.publicKey, attestor: att.publicKey, paused: true, pending: null });
const quiet = () => { const out = []; return { out, log: (s) => out.push(s) }; };

test("instruction encodings match the program accounts", () => {
  const p = proposeIx(auth.publicKey, nw.publicKey);
  assert.deepEqual(p.data.subarray(0, 8), disc("global:propose_authority"));
  assert.ok(new PublicKey(p.data.subarray(8)).equals(nw.publicKey));
  assert.deepEqual(p.keys.map((k) => [k.isSigner, k.isWritable]), [[false, false], [false, true], [true, true], [false, false]]);
  const a = acceptIx(auth.publicKey, nw.publicKey);
  assert.deepEqual(a.data, disc("global:accept_authority"));
  assert.deepEqual(a.keys.map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, true], [false, true], [true, false]]);
  const c = cancelIx(auth.publicKey, auth.publicKey);
  assert.deepEqual(c.data, disc("global:cancel_authority"));
  assert.ok(PENDING_PDA.equals(PublicKey.findProgramAddressSync([Buffer.from("pending_authority")], PROGRAM_ID)[0]));
});

test("propose: dry run by default, refuses non-authority/zero/self, --send works while paused", async () => {
  const st = fresh(); const c = mockConn(st);
  let r = await propose(["--new", newP, "--authority", authP], { connection: c, ...quiet() });
  assert.ok(r.dryRun); assert.equal(c.calls.send, 0); assert.equal(st.pending, null);
  for (const [args, re] of [[["--new", newP, "--authority", rogueP], /not config.authority/],
                            [["--new", PublicKey.default.toBase58(), "--authority", authP], /zero/],
                            [["--new", authP, "--authority", authP], /already the authority/]]) {
    const q = quiet(); r = await propose(args, { connection: c, log: q.log });
    assert.ok(!r.ok); assert.match(r.errs[0], re);
  }
  assert.equal(c.calls.sim, 1);
  r = await propose(["--new", newP, "--authority", authP, "--send"], { connection: c, ...quiet() });
  assert.equal(r.sig, "SIG_TEST"); assert.ok(st.pending.proposed.equals(nw.publicKey));
});

test("accept: only the proposed key; then authority changes", async () => {
  const st = fresh(); st.pending = { proposed: nw.publicKey, proposer: auth.publicKey }; const c = mockConn(st);
  let r = await accept(["--signer", rogueP, "--send"], { connection: c, ...quiet() });
  assert.ok(!r.ok); assert.equal(c.calls.send, 0);
  r = await accept(["--signer", newP], { connection: c, ...quiet() });
  assert.ok(r.dryRun);
  r = await accept(["--signer", newP, "--send"], { connection: c, ...quiet() });
  assert.ok(r.ok && r.sig); assert.ok(st.authority.equals(nw.publicKey)); assert.equal(st.pending, null);
});

test("accept: refuses stale proposal and missing proposal", async () => {
  const st = fresh(); const c = mockConn(st);
  assert.match((await accept(["--signer", newP], { connection: c, ...quiet() })).errs[0], /no pending/);
  st.pending = { proposed: nw.publicKey, proposer: rogue.publicKey };
  assert.match((await accept(["--signer", newP], { connection: c, ...quiet() })).errs[0], /previous authority/);
});

test("accept --print-squads prints the instruction without any keypair", async () => {
  const vault = Keypair.generate().publicKey;
  const st = fresh(); st.pending = { proposed: vault, proposer: auth.publicKey }; const c = mockConn(st);
  const q = quiet();
  const r = await accept(["--print-squads"], { connection: c, log: q.log });
  assert.ok(r.printed); assert.equal(c.calls.sim + c.calls.send, 0);
  const all = q.out.join("\n");
  assert.ok(all.includes(disc("global:accept_authority").toString("hex")));
  assert.ok(all.includes(`3. ${vault.toBase58()}  readonly, signer`));
  assert.ok(all.includes(`2. ${auth.publicKey.toBase58()}  writable`));
  assert.ok(!(await accept(["--print-squads", "--new-authority", rogue.publicKey.toBase58()], { connection: c, ...quiet() })).ok);
});

test("cancel: authority only; closes pending", async () => {
  const st = fresh(); st.pending = { proposed: nw.publicKey, proposer: auth.publicKey }; const c = mockConn(st);
  assert.ok(!(await cancel(["--authority", rogueP, "--send"], { connection: c, ...quiet() })).ok);
  assert.ok((await cancel(["--authority", authP], { connection: c, ...quiet() })).dryRun);
  const r = await cancel(["--authority", authP, "--send"], { connection: c, ...quiet() });
  assert.ok(r.sig); assert.equal(st.pending, null);
  assert.match((await cancel(["--authority", authP], { connection: c, ...quiet() })).errs[0], /no pending/);
});

test("never prints secret key bytes", async () => {
  const st = fresh(); const c = mockConn(st); const q = quiet();
  await propose(["--new", newP, "--authority", authP, "--send"], { connection: c, log: q.log });
  await accept(["--signer", newP, "--send"], { connection: c, log: q.log });
  const all = q.out.join("\n");
  for (const kp of [auth, nw]) {
    assert.ok(!all.includes(Buffer.from(kp.secretKey).toString("hex")));
    assert.ok(!all.includes(Buffer.from(kp.secretKey).toString("base64")));
    assert.ok(!all.includes(JSON.stringify([...kp.secretKey]).slice(1, 40)));
  }
});
