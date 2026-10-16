// Runs the ready rows 231-240 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_polk_fl.mjs","post_olmsted_mn.mjs","post_solano_ca.mjs","post_contracosta_ca.mjs","post_ector_tx.mjs","post_middlesex_ma.mjs","post_guadalupe_tx.mjs","post_capitol_ct.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
