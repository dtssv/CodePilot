/**
 * Compile a Bun entry (ESM, with top-level await + native addons) into a
 * single self-contained executable via `Bun.build({ compile })`.
 *
 * The TUI cannot use the CLI's esbuild→CJS→pkg path: Ink/yoga use top-level
 * await (no CJS output) and @yao-pkg/pkg can't reliably run an ESM entry from
 * its snapshot FS. Bun handles ESM + TLA + native modules natively.
 *
 * Run with Bun: `bun scripts/package/bundle-bun.mjs <entry> <outfile> <target>`
 *   target is a Bun compile target, e.g. bun-darwin-arm64 / bun-linux-x64 /
 *   bun-windows-x64. Omit to compile for the host.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const [entry, outfile, target] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bun bundle-bun.mjs <entry> <outfile> [target]");
  process.exit(1);
}

let coreVersion = "0.0.0";
try {
  coreVersion = require("@codepilot/core/package.json").version ?? coreVersion;
} catch {
  /* keep default */
}
const PKG_LITERAL = JSON.stringify({ name: "@codepilot/core", version: coreVersion });

const fixups = {
  name: "codepilot-fixups",
  setup(b) {
    // Ink lazy-imports react-devtools-core only when process.env.DEV==="true".
    // It is a dev-only optional dep; stub it so the shipped binary resolves.
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "cp-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "cp-stub" }, () => ({
      contents: "export default { connectToDevTools() {} };",
      loader: "js",
    }));
    // @codepilot/core probes its own version via require("../package.json"),
    // which has no backing file in Bun's virtual FS. Inline it to a literal
    // (mirrors scripts/package/bundle-node.mjs for the CLI).
    b.onLoad({ filter: /packages[\\/]core[\\/]dist[\\/].*\.js$/ }, (args) => {
      let code = readFileSync(args.path, "utf8");
      code = code.replace(
        /\brequire\s*\(\s*["'](?:\.\.\/package\.json|@codepilot\/core\/package\.json)["']\s*\)/g,
        PKG_LITERAL,
      );
      return { contents: code, loader: "js" };
    });
  },
};

const compile = target ? { target, outfile } : { outfile };
const result = await Bun.build({
  entrypoints: [entry],
  compile,
  plugins: [fixups],
  define: { "process.env.DEV": '"false"' },
});

if (!result.success) {
  for (const l of result.logs) console.error(l.message ?? l);
  process.exit(1);
}
console.error(`[package] bun compiled ${entry} → ${outfile}${target ? ` (${target})` : ""}`);
