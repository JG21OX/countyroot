// Runs the ready rows 271-280 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_hamilton_in.mjs","post_suffolk_va.mjs","post_essex_ma.mjs","post_stjoseph_in.mjs","post_norfolk_ma.mjs","post_wichita_tx.mjs","post_clay_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
