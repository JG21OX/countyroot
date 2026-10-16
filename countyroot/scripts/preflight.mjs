// Guard for every post/update script: verify the packet before anything is sent.
//
// Each script calls guardProgram(program) right after creating it. postRoot/updateRoot builders
// are wrapped so .rpc() / .transaction() / .instruction() first:
//   1. find the local packet (COUNTYROOT_PACKETS_DIR, default ~/Downloads) for the fips/epoch,
//   2. run scripts/verify.mjs checks (every leaf, root, n_parcels, fips, epoch),
//   3. apply the closed-epoch policy (closed-epochs.json + on-chain history via the script's RPC).
// Escape hatch: --skip-verify (or COUNTYROOT_SKIP_VERIFY=1) prints a loud warning and skips the checks.
import { verifyPacket, locatePacket, checkEpochPolicy, VerifyError } from "./verify.mjs";

export const skipRequested = () => process.argv.includes("--skip-verify") || process.env.COUNTYROOT_SKIP_VERIFY === "1";

function loud(msg) {
  const bar = "!".repeat(72);
  console.error(`\n${bar}\n!!! ${msg}\n${bar}\n`);
}

const hex = (v) => Buffer.from(v).toString("hex");
const n = (v) => (v && typeof v.toString === "function" ? v.toString() : String(v));

async function check(program, ixName, args, accounts, opts) {
  let fips, epoch, nParcels, merkleRoot;
  if (ixName === "postRoot") {
    [fips, epoch, nParcels, merkleRoot] = [Number(n(args[0])), Number(n(args[1])), n(args[2]), hex(args[3])];
  } else {
    [nParcels, merkleRoot] = [n(args[0]), hex(args[1])];
    if (!accounts?.countyRoot) throw new VerifyError("updateRoot without a countyRoot account");
    const acct = await (opts.fetchCountyRoot ?? ((k) => program.account.countyRoot.fetch(k)))(accounts.countyRoot);
    [fips, epoch] = [acct.fips, acct.epoch];
  }
  const rootPath = (opts.locate ?? locatePacket)({ fips, epoch, merkleRoot });
  const r = await verifyPacket({ rootPath, expect: { fips, epoch, nParcels, merkleRoot } });
  await checkEpochPolicy({ fips, epoch, op: ixName === "postRoot" ? "post" : "update" },
    { connection: opts.connection ?? program.provider?.connection });
  console.log(`preflight OK: fips ${fips} epoch ${epoch}, ${r.nParcels} parcels, root ${r.root} (${r.rootPath})`);
}

export function guardProgram(program, opts = {}) {
  const methods = program.methods;
  const guarded = new Set(["postRoot", "updateRoot"]);
  const wrapped = new Proxy(methods, {
    get(target, prop) {
      const orig = target[prop];
      if (!guarded.has(prop) || typeof orig !== "function") return orig;
      return (...args) => {
        const builder = orig.apply(target, args);
        let accounts;
        const accts = builder.accounts?.bind(builder), accStrict = builder.accountsStrict?.bind(builder), accPartial = builder.accountsPartial?.bind(builder);
        if (accts) builder.accounts = (a) => { accounts = a; return accts(a); };
        if (accStrict) builder.accountsStrict = (a) => { accounts = a; return accStrict(a); };
        if (accPartial) builder.accountsPartial = (a) => { accounts = a; return accPartial(a); };
        for (const send of ["rpc", "rpcAndKeys", "transaction", "instruction", "simulate"]) {
          const f = builder[send]?.bind(builder);
          if (!f) continue;
          builder[send] = async (...x) => {
            if (skipRequested()) loud(`--skip-verify: SENDING ${prop} WITHOUT PACKET VERIFICATION`);
            else {
              try { await check(program, prop, args, accounts, opts); }
              catch (e) {
                console.error(`\nPREFLIGHT FAILED (${prop}): ${e.message}\nNothing was sent. Fix the packet, or re-run with --skip-verify to override.`);
                process.exitCode = 1;
                throw e instanceof VerifyError ? e : new VerifyError(e.message);
              }
            }
            return f(...x);
          };
        }
        return builder;
      };
    },
  });
  Object.defineProperty(program, "methods", { value: wrapped, configurable: true });
  return program;
}
