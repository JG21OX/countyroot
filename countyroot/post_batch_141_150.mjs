// Runs the ready rows 141-150 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_ellis_tx.mjs","post_cumberland_nc.mjs","post_pulaski_ar.mjs","post_randall_tx.mjs","post_potter_tx.mjs","post_leon_fl.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
