// Runs the ready rows 1-10 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_queens_ny.mjs","post_bronx_ny.mjs","post_richmond_ny.mjs","post_losangeles_ca.mjs","post_cook_il.mjs","post_dupage_il.mjs","post_harris_tx.mjs","post_fortbend_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
