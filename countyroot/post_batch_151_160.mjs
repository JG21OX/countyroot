// Runs the ready rows 151-160 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_richmond_ga.mjs","post_yavapai_az.mjs","post_clark_wa.mjs","post_ventura_ca.mjs","post_jefferson_al.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
