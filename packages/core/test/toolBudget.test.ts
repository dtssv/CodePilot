import { describe, expect, it } from "vitest";
import {
  enforceToolResultBudget,
  MAX_TOOL_RESULT_CHARS_PER_MESSAGE,
} from "../src/agent/agent-toolBudget.js";

describe("enforceToolResultBudget", () => {
  it("leaves small results alone", async () => {
    const arts = new Map<string, string>();
    const out = await enforceToolResultBudget(
      [
        { content: "a".repeat(100), name: "read_file" },
        { content: "b".repeat(200), name: "grep" },
      ],
      async (text) => {
        const ref = `art_${arts.size}`;
        arts.set(ref, text);
        return ref;
      },
      50_000,
    );
    expect(out[0]!.content.length).toBe(100);
    expect(out[1]!.content.length).toBe(200);
    expect(arts.size).toBe(0);
  });

  it("shrinks the largest results until under budget", async () => {
    const arts = new Map<string, string>();
    const big = "x".repeat(120_000);
    const mid = "y".repeat(90_000);
    const out = await enforceToolResultBudget(
      [
        { content: big, name: "grep" },
        { content: mid, name: "bash" },
        { content: "ok", name: "ls" },
      ],
      async (text, hint) => {
        const ref = `art_${arts.size}_${hint}`;
        arts.set(ref, text);
        return ref;
      },
      100_000,
    );
    const total = out.reduce((s, i) => s + i.content.length, 0);
    expect(total).toBeLessThanOrEqual(100_000);
    expect(out[2]!.content).toBe("ok");
    expect(out.some((i) => i.artifactRef)).toBe(true);
    expect(out.some((i) => i.content.includes("omitted"))).toBe(true);
  });

  it("default budget matches the exported constant", () => {
    expect(MAX_TOOL_RESULT_CHARS_PER_MESSAGE).toBe(200_000);
  });
});
