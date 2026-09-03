// esbuild bundle script.
//
// Bundles src/extension.ts into dist/extension.js as CommonJS (VSCode loads
// extensions with `require`, regardless of the package.json `type` field).
// `vscode` is treated as an external module so it isn't inlined.

import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: [resolve(root, "src/extension.ts")],
  bundle: true,
  outfile: resolve(root, "dist/extension.js"),
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  external: ["vscode"],
  logLevel: "info",
  // `process` and `Buffer` exist in the extension host; nothing to polyfill.
  banner: {
    // vscode's loader wraps the module in a function; we don't need a banner.
    js: "// CodePilot VSCode extension — bundled by esbuild",
  },
};

async function run() {
  if (watch) {
    const ctx = await context(config);
    await ctx.watch();
    console.log("watching…");
  } else {
    await build(config);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});