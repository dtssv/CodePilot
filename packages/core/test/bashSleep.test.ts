import { describe, expect, it } from "vitest";
import { detectBlockedSleepPattern, bashTool } from "../src/tools/bash.js";
import type { ToolContext } from "../src/tools/types.js";

describe("detectBlockedSleepPattern", () => {
  it("blocks bare sleep ≥2s", () => {
    expect(detectBlockedSleepPattern("sleep 5")).toBe("standalone sleep 5");
    expect(detectBlockedSleepPattern("sleep 2")).toBe("standalone sleep 2");
  });

  it("allows sub-2s pacing sleeps", () => {
    expect(detectBlockedSleepPattern("sleep 1")).toBeNull();
    expect(detectBlockedSleepPattern("sleep 0")).toBeNull();
  });

  it("blocks sleep chained with more work", () => {
    expect(detectBlockedSleepPattern("sleep 5 && curl localhost")).toMatch(/followed by/);
  });

  it("allows sleep inside pipelines / not first segment", () => {
    expect(detectBlockedSleepPattern("echo hi | sleep 5")).toBeNull();
    // Bare sleep after `;` / `&&` must not slip through (not only the first segment).
    expect(detectBlockedSleepPattern("true; sleep 5")).toBe("standalone sleep 5");
    expect(detectBlockedSleepPattern("echo hi && sleep 3")).toBe("standalone sleep 3");
  });
});

describe("bash tool sleep gate", () => {
  it("refuses foreground sleep ≥2s", async () => {
    const r = await bashTool.execute(
      { command: "sleep 5" },
      { cwd: "/tmp" } as unknown as ToolContext,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Blocked:.*sleep 5/);
    expect(r.content).toMatch(/run_in_background/);
  });
});
