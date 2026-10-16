// Runs the ready rows 111-120 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_washoe_nv.mjs","post_allen_in.mjs","post_erie_ny.mjs","post_lubbock_tx.mjs","post_webb_tx.mjs","post_stlucie_fl.mjs","post_pinellas_fl.mjs","post_lucas_oh.mjs","post_forsyth_nc.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
