// Runs the ready rows 241-250 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_yellowstone_mt.mjs","post_davidson_nc.mjs","post_randolph_nc.mjs","post_galveston_tx.mjs","post_doaana_nm.mjs","post_vanderburgh_in.mjs","post_naugatuckvalley_ct.mjs","post_cabarrus_nc.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
