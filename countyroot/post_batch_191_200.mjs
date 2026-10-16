// Runs the ready rows 191-200 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_hampden_ma.mjs","post_greaterbridgeport_ct.mjs","post_hidalgo_tx.mjs","post_alachua_fl.mjs","post_brevard_fl.mjs","post_mclennan_tx.mjs","post_weld_co.mjs","post_midland_tx.mjs","post_martin_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
