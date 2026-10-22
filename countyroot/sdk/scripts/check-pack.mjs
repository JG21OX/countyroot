// Fails if the npm tarball would contain secrets, keypairs, local paths or personal data.
import { execSync } from "node:child_process";
import fs from "node:fs";
const [{ files }] = JSON.parse(execSync("npm pack --dry-run --json", { encoding: "utf8" }));
// Personal terms (names, emails, usernames) are not written here; pass them at run time:
//   CR_PACK_DENY="term1,term2" npm run check-pack
const extra = (process.env.CR_PACK_DENY || "").split(",").map((t) => t.trim()).filter(Boolean)
  .map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
const bad = [/\/Users\//, /\/home\/[a-z]/, /[A-Za-z]:\\Users\\/, /PRIVATE KEY/, /secret_access_key/i, /R2_SECRET/, /\.config\/solana/, /@(gmail|icloud|outlook|yahoo)\./i, ...extra];
const badName = /(^|\/)(\.env|.*keypair.*\.json|id\.json|.*\.pem|.*\.key)$/i;
let fail = 0;
for (const { path } of files) {
  if (badName.test(path)) { console.error(`forbidden file: ${path}`); fail++; continue; }
  const text = fs.readFileSync(path, "utf8");
  for (const re of bad) if (re.test(text)) { console.error(`${path}: matches ${re}`); fail++; }
}
if (fail) process.exit(1);
console.log(`pack check OK: ${files.length} files, no secrets, keypairs, local paths or personal data`);
