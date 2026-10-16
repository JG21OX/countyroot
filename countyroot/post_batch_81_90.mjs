// Runs the ready rows 81-90 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_osage_ok.mjs","post_wagoner_ok.mjs","post_rogers_ok.mjs","post_hillsborough_fl.mjs","post_arapahoe_co.mjs","post_adams_co.mjs","post_douglas_co.mjs","post_cuyahoga_oh.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
