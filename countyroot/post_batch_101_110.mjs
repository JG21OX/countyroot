// Runs the ready rows 101-110 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_aransas_tx.mjs","post_hamilton_oh.mjs","post_guilford_nc.mjs","post_allegheny_pa.mjs","post_ramsey_mn.mjs","post_orange_nc.mjs","post_hudson_nj.mjs","post_lancaster_ne.mjs","post_anchorage_ak.mjs","post_dane_wi.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
