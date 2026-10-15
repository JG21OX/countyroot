// Runs the ready rows 171-180 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_kendall_il.mjs","post_sonoma_ca.mjs","post_caddo_la.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
