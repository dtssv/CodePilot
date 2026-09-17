import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    // The client uses 60s request timeouts; don't let leftover handles keep
    // the worker alive after the run finishes.
    unrefTimers: true,
    setupFiles: ["./test/setup.ts"],
    alias: {
      // The real `vscode` module only exists inside the extension host.
      // Redirect imports to our in-memory stub.
      vscode: fileURLToPath(new URL("./test/__mocks__/vscode.ts", import.meta.url)),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 50,
      },
    },
  },
});
