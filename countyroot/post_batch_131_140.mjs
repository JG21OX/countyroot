// Runs the ready rows 131-140 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_eastbatonrouge_la.mjs","post_sanbernardino_ca.mjs","post_stanislaus_ca.mjs","post_saltlake_ut.mjs","post_worcester_ma.mjs","post_westchester_ny.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
