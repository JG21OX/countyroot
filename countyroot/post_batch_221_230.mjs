// Runs the ready rows 221-230 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_jones_tx.mjs","post_brazoria_tx.mjs","post_brazos_tx.mjs","post_palmbeach_fl.mjs","post_newhanover_nc.mjs","post_shawnee_ks.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
