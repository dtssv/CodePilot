import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    setupFiles: ["./test/setup.ts"],
    // Run each test file in a forked child process and bound the pool. Several
    // suites spawn real subprocesses/servers (MCP stdio children, the loopback
    // net proxy, bash jobs), so forks isolate those better than worker threads.
    // The CI runners were OOM-killing workers — "Worker exited unexpectedly" from
    // tinypool — because vitest's default fork count = CPU count, and the combined
    // V8 heaps plus the spawned children exceeded the runner's memory ceiling
    // (it surfaced on Node 20 everywhere and Node 22 on ubuntu; Node 22/macOS had
    // just enough headroom). Cap concurrency to 2 and bound each fork's old-space
    // so the peak stays well under the ceiling. The suite runs in ~15s either way.
    // Override with CODEPILOT_TEST_FORKS when a beefier host wants more parallelism.
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: Number(process.env.CODEPILOT_TEST_FORKS) || 2,
        execArgv: ["--max-old-space-size=1024"],
      },
    },
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
