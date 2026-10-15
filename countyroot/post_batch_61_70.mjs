// Runs the ready rows 61-70 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_fresno_ca.mjs","post_pima_az.mjs","post_sacramento_ca.mjs","post_fulton_ga.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
