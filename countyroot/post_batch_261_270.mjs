// Runs the ready rows 261-270 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_pueblo_co.mjs","post_flagler_fl.mjs","post_washington_ut.mjs","post_brown_wi.mjs","post_washington_ar.mjs","post_plymouth_ma.mjs","post_boulder_co.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
