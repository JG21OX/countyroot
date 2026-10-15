// Runs the ready rows 91-100 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_honolulu_hi.mjs","post_orange_ca.mjs","post_orange_fl.mjs","post_fayette_ky.mjs","post_sanjoaquin_ca.mjs","post_essex_nj.mjs","post_riverside_ca.mjs","post_nueces_tx.mjs","post_sanpatricio_tx.mjs","post_kleberg_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
