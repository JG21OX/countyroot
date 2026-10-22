// CJS builds for require() users and a self-contained ESM browser build of @countyroot/sdk/web.
import { build } from "esbuild";
const banner = { js: "/* @countyroot/sdk | MIT | https://countyroot.com */" };
await build({ entryPoints: ["src/index.ts"], outfile: "dist/cjs/index.cjs", bundle: true, platform: "node", format: "cjs", target: "node18", packages: "external", banner });
await build({ entryPoints: ["src/web.ts"], outfile: "dist/cjs/web.cjs", bundle: true, platform: "neutral", format: "cjs", target: "es2020", banner });
await build({ entryPoints: ["src/web.ts"], outfile: "dist/browser/countyroot-web.min.js", bundle: true, platform: "browser", format: "esm", target: "es2020", minify: true, banner });
console.log("bundled: dist/cjs/index.cjs, dist/cjs/web.cjs, dist/browser/countyroot-web.min.js");
