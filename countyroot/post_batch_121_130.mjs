// Runs the ready rows 121-130 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_chesapeake_va.mjs","post_richmond_va.mjs","post_lee_fl.mjs","post_morgan_al.mjs","post_norfolk_va.mjs","post_spokane_wa.mjs","post_pierce_wa.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
