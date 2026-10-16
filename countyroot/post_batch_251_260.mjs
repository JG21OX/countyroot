// Runs the ready rows 251-260 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_utah_ut.mjs","post_sandoval_nm.mjs","post_tuscaloosa_al.mjs","post_eaton_mi.mjs","post_smith_tx.mjs","post_snohomish_wa.mjs","post_jefferson_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
