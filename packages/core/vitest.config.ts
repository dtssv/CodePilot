import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/__mocks__/**",
        "src/**/types.ts",
        "src/**/index.ts",
      ],
      thresholds: {
 // Coverage target: core ≥80%. Providers (anthropic/openai/copilot/sse)
 // are real HTTP clients with minimal unit coverage and pull the average
 // down. Gate sits under the local floor (~72% lines) with headroom for
 // OS/CI variance.
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 60,
      },
    },
  },
});
