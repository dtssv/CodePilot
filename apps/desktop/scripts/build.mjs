// Bundles the Electron main process (ESM) and preload (CJS: sandboxed
// preloads cannot be modules). Workspace packages stay external and load
// from node_modules at runtime.

import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron", "@codepilot/*"],
  logLevel: "info",
};

await build({ ...common, entryPoints: [resolve(root, "src/main.ts")], outfile: resolve(root, "dist/main.js"), format: "esm" });
await build({ ...common, entryPoints: [resolve(root, "src/preload.ts")], outfile: resolve(root, "dist/preload.cjs"), format: "cjs" });
