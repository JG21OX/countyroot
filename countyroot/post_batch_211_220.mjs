// Runs the ready rows 211-220 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_westernconnecticut_ct.mjs","post_southcentralconnecticut_ct.mjs","post_hampton_va.mjs","post_macomb_mi.mjs","post_cass_nd.mjs","post_taylor_tx.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
