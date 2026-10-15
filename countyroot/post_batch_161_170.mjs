// Runs the ready rows 161-170 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_cameron_tx.mjs","post_summit_oh.mjs","post_broward_fl.mjs","post_chatham_nc.mjs","post_newportnews_va.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
