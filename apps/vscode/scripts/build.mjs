// esbuild bundle script.
//
// Bundles src/extension.ts into dist/extension.cjs as CommonJS. The package
// has `"type": "module"` for build scripts, so the entry MUST use a `.cjs`
// suffix — otherwise VS Code treats `extension.js` as ESM and activation
// fails with `module is not defined`. `vscode` stays external.
// Also copies the web embed UI and (when protocol is built) the bundled
// CodePilot CLI into resources/ so install-only works without a system CLI.

import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");
const repoRoot = resolve(root, "../..");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: [resolve(root, "src/extension.ts")],
  bundle: true,
  outfile: resolve(root, "dist/extension.cjs"),
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  external: ["vscode"],
  logLevel: "info",
  banner: {
    js: "// CodePilot VSCode extension — bundled by esbuild",
  },
};

/** The chat view is the shared web UI's single-file embed build. */
function copyWebview() {
  const src = resolve(root, "../web/dist-embed/index.html");
  if (!existsSync(src)) {
    throw new Error(
      "apps/web/dist-embed/index.html missing — run `pnpm --filter @codepilot/web build` first (package:vscode does this)",
    );
  }
  mkdirSync(resolve(root, "media/webview"), { recursive: true });
  copyFileSync(src, resolve(root, "media/webview/index.html"));
  console.log(`copied webview embed (${src})`);
}

/** Ship a self-contained CLI so the extension works without a system install. */
function bundleEngineCli() {
  const script = resolve(repoRoot, "scripts/package/bundle-plugin-cli.mjs");
  const outfile = resolve(root, "resources/codepilot-cli.cjs");
  mkdirSync(resolve(root, "resources"), { recursive: true });
  const r = spawnSync(process.execPath, [script, outfile], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.warn(
      "! bundled engine CLI missing — extension will fall back to codepilot on PATH. " +
        "Run `pnpm --filter @codepilot/protocol build` then rebuild the extension.",
    );
  }
}

async function run() {
  copyWebview();
  bundleEngineCli();
  // Drop the pre-.cjs entry so vsce never ships a stale ESM-looking main.
  for (const stale of ["extension.js", "extension.js.map"]) {
    const p = resolve(root, "dist", stale);
    if (existsSync(p)) rmSync(p);
  }
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
