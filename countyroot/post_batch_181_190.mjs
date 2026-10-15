// Runs the ready rows 181-190 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_placer_ca.mjs","post_bell_tx.mjs","post_passaic_nj.mjs","post_alexandria_va.mjs","post_monterey_ca.mjs","post_wyandotte_ks.mjs","post_jefferson_co.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
