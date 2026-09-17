import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    // The protocol server (`codepilot serve --web`) allows the localhost
    // origin on its own port by default, so a dev server on a different port
    // must be added to its allowlist:
    //   codepilot serve --web --allow-origin http://localhost:5173
    port: 5173,
    strictPort: false,
  },
});
