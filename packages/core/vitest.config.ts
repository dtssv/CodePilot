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
        // ROADMAP target: core ≥80%. Current: ~61% lines / 68% functions.
        // Providers (anthropic/openai/copilot/sse) are real HTTP clients
        // with minimal unit coverage and pull the average down. We set the
        // gate just below the current floor so CI stays green, and raise
        // it as we add provider integration tests.
        lines: 60,
        functions: 65,
        statements: 60,
        branches: 65,
      },
    },
  },
});
