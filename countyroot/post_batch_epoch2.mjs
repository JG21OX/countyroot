// Epoch 2 corrections (wrong-county epoch 1 packets): Morgan.AL, StLucie.FL, Cleveland.OK, Dorchester.SC, Scott.IA. Stops on first failure.
import { execFileSync } from "child_process";
const scripts = ["post_morgan_al_e2.mjs","post_stlucie_fl_e2.mjs","post_cleveland_ok_e2.mjs","post_dorchester_sc_e2.mjs","post_scott_ia_e2.mjs"];
for (const s of scripts) { console.log(`== ${s}`); execFileSync("node", [s], { stdio: "inherit", env: process.env }); }
