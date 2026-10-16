// Runs the ready rows 71-80 post scripts in order. Stops on first failure.
import { execFileSync } from "child_process";
if (process.argv.includes("--skip-verify")) process.env.COUNTYROOT_SKIP_VERIFY = "1"; // children inherit env
const scripts = ["post_wake_nc.mjs","post_durham_nc.mjs","post_elpaso_co.mjs","post_virginiabeach_va.mjs","post_alameda_ca.mjs","post_hennepin_mn.mjs","post_tulsa_ok.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
