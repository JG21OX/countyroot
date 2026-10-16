// Runs the ready rows 41-50 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_denver_co.mjs","post_davidson_tn.mjs","post_oklahoma_ok.mjs","post_canadian_ok.mjs","post_cleveland_ok.mjs","post_districtofcolumbia_dc.mjs","post_elpaso_tx.mjs","post_clark_nv.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
