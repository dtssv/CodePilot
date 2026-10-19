// Build for IDE webviews (VSCode, IntelliJ/JCEF). Those hosts load one HTML
// string with their own CSP, so everything is emitted into a single file by
// scripts/inline-embed.mjs after this build.
import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config.js";

export default mergeConfig(
  base,
  defineConfig({
    base: "./",
    build: {
      outDir: "dist-embed",
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      modulePreload: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }),
);
