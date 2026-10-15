// Runs the ready rows 11-20 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_montgomery_tx.mjs","post_waller_tx.mjs","post_maricopa_az.mjs","post_philadelphia_pa.mjs","post_bexar_tx.mjs","post_medina_tx.mjs","post_comal_tx.mjs","post_sandiego_ca.mjs","post_dallas_tx.mjs","post_collin_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
