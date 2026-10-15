// Runs the ready rows 201-210 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_tulare_ca.mjs","post_onondaga_ny.mjs","post_union_nj.mjs","post_hinds_ms.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
