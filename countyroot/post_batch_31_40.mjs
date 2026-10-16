// Runs the ready rows 31-40 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_hays_tx.mjs","post_bastrop_tx.mjs","post_santaclara_ca.mjs","post_mecklenburg_nc.mjs","post_franklin_oh.mjs","post_delaware_oh.mjs","post_fairfield_oh.mjs","post_marion_in.mjs","post_sanfrancisco_ca.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
