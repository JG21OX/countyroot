// Runs the ready rows 21-30 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_denton_tx.mjs","post_rockwall_tx.mjs","post_kaufman_tx.mjs","post_tarrant_tx.mjs","post_parker_tx.mjs","post_johnson_tx.mjs","post_wise_tx.mjs","post_duval_fl.mjs","post_williamson_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
