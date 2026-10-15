// Runs the ready rows 51-60 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_multnomah_or.mjs","post_washington_or.mjs","post_clackamas_or.mjs","post_baltimore_md.mjs","post_milwaukee_wi.mjs","post_washington_wi.mjs","post_waukesha_wi.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
