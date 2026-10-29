import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the built SPA works both when served over http
  // (`codepilot serve --web`) from `/` and when loaded via `file://` in the
  // desktop app (assets resolve next to index.html either way).
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
 // The protocol server (`codepilot serve --web`) allows the localhost
 // origin on its own port by default, so a dev server on a different port
 // must be added to its allowlist:
 // codepilot serve --web --allow-origin http://localhost:5173
    port: 5173,
    strictPort: false,
  },
});
