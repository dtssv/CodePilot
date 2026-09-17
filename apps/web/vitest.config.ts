import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The state layer and protocol client are pure TypeScript, so they run in
    // node without a DOM. Components are deliberately thin wrappers over that
    // logic — the interesting behaviour is tested here, not through a
    // simulated browser.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/main.tsx", "src/components/**"],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 50,
      },
    },
  },
});
