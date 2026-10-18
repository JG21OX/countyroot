// List built proof files and write the R2 upload commands for them (nothing is uploaded by this script).
//   node scripts/proof_upload_list.mjs --dir <proofs staging dir> [--bucket countyroot-packets] [--jobs 8]
//        [--previous <dir or upload-list.txt of what is already on R2>]   (then only new/changed files are listed)
// Writes <dir>/upload-list.txt (R2 key, bytes) and <dir>/upload.sh. Run upload.sh from <dir> yourself, after
// scripts/scan_proofs.mjs passes. Keys mirror the packet keys: <label>/<label>.<epoch>.<month>.proofs/...
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";

const TYPES = { ".json": "application/json", ".bin": "application/octet-stream" };
export function listProofFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.proofs\//.test(path.relative(dir, p) + (e.isDirectory() ? "/" : ""))) out.push(p); } };
  walk(dir);
  return out.map((p) => ({ key: path.relative(dir, p).split(path.sep).join("/"), bytes: fs.statSync(p).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") })).sort((a, b) => a.key.localeCompare(b.key));
}
/** key -> sha256 of what is already uploaded: from a staging dir, or an upload-list.txt with a sha256 column. */
export function previousHashes(prev) {
  if (fs.statSync(prev).isDirectory()) return new Map(listProofFiles(prev).map((f) => [f.key, f.sha256]));
  return new Map(fs.readFileSync(prev, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")).filter((c) => c[2]).map((c) => [c[0], c[2]]));
}
export function main(argv, log = console.log) {
  const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  if (!a.dir) { log("usage: proof_upload_list.mjs --dir <dir> [--bucket countyroot-packets] [--jobs 8]"); return 2; }
  const bucket = a.bucket ?? "countyroot-packets", jobs = Number(a.jobs ?? 8);
  const all = listProofFiles(a.dir);
  if (all.some((f) => !/^[A-Za-z0-9.]+\/[A-Za-z0-9.]+\.\d+\.\d{4}-\d\d\.proofs\/(index\.json|top\.bin|s\/\d+\.json|c\/\d+\.bin|x\/\d+\.json|p\/index\.json|p\/([0-9a-f]+|_)\.json)$/.test(f.key))) throw new Error("unexpected file in the proofs dir");
  // full manifest (with sha256) of everything that will be on R2 afterwards, for the next --previous
  fs.writeFileSync(path.join(a.dir, "manifest.txt"), all.map((f) => `${f.key}\t${f.bytes}\t${f.sha256}`).join("\n") + "\n");
  const prev = a.previous ? previousHashes(a.previous) : new Map();
  const files = all.filter((f) => prev.get(f.key) !== f.sha256);
  fs.writeFileSync(path.join(a.dir, "upload-list.txt"), files.map((f) => `${f.key}\t${f.bytes}\t${f.sha256}`).join("\n") + (files.length ? "\n" : ""));
  // each county's index.json goes last, so a county only looks published once all its other files are up.
  const row = (f) => `${f.key} ${TYPES[path.extname(f.key)]}`;
  fs.writeFileSync(path.join(a.dir, "upload-data.txt"), files.filter((f) => !f.key.endsWith(".proofs/index.json")).map(row).join("\n") + "\n");
  fs.writeFileSync(path.join(a.dir, "upload-index.txt"), files.filter((f) => f.key.endsWith(".proofs/index.json")).map(row).join("\n") + "\n");
  // index files are small and change on rebuilds: 5-minute cache; everything else is content-stable: 1 day.
  const put = `case "$0" in */index.json) cc="public, max-age=300";; *) cc="public, max-age=86400";; esac; npx wrangler r2 object put "${bucket}/$0" --file "$0" --content-type "$1" --cache-control "$cc" --remote >/dev/null && echo "ok $0"`;
  fs.writeFileSync(path.join(a.dir, "upload.sh"), `#!/bin/sh
# Uploads ${files.length} proof files (${files.reduce((s, f) => s + f.bytes, 0)} bytes) to R2 bucket ${bucket}. Run it from anywhere.
set -e
cd "$(dirname "$0")"
xargs -P ${jobs} -n 2 sh -c '${put}' < upload-data.txt
xargs -P 1 -n 2 sh -c '${put}' < upload-index.txt
echo "uploaded ${files.length} files"
`, { mode: 0o755 });
  log(`${files.length} of ${all.length} files to upload (${a.previous ? `${all.length - files.length} unchanged since --previous` : "all"}), ${files.reduce((s, f) => s + f.bytes, 0)} bytes -> ${path.join(a.dir, "upload-list.txt")}, ${path.join(a.dir, "upload.sh")}`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
