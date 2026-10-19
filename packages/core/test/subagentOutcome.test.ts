import { describe, expect, it } from "vitest";
import { assessSubagentOutcome } from "../src/subagent.js";
import type { Event } from "../src/types.js";
import { taskTool } from "../src/tools/task.js";

describe("assessSubagentOutcome", () => {
  it("marks provider errors with no text as failed and surfaces the message", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "OBJECTIVE" }],
      },
      {
        type: "error",
        message: 'OpenAI 404: {"error":{"message":"Model not exist."}}',
        recoverable: true,
      },
      { type: "status", status: "idle" },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.steps).toBe(0);
    expect(r.conclusion).toMatch(/### Blocker/);
    expect(r.conclusion).toMatch(/Model not exist/);
  });

  it("marks empty assistant output as failed", () => {
    const events: Event[] = [
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "   " }],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(false);
    expect(r.conclusion).toMatch(/no final text/);
  });

  it("returns ok with the assistant text when the run succeeded", () => {
    const events: Event[] = [
      {
        type: "tool_call",
        id: "t1",
        name: "grep",
        input: { pattern: "x" },
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "### Findings\n- found it\n\n### Key references\n- `a.ts:1`\n\n### Recommendations\n- none",
          },
        ],
      },
    ];
    const r = assessSubagentOutcome(events);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(1);
    expect(r.conclusion).toContain("### Findings");
  });
});

describe("task tool soft-failure reporting", () => {
  it("marks fan-out results as isError when runners return ok:false", async () => {
    const tool = taskTool;
    tool.runner = {
      async run() {
        return {
          ok: false,
          steps: 0,
          conclusion: "### Blocker\nOpenAI 404: Model not exist.",
        };
      },
    };
    tool._sem = undefined;
    const r = await tool.execute(
      {
        tasks: [
          { objective: "a", agent_type: "explore" },
          { objective: "b", agent_type: "explore" },
          { objective: "c", agent_type: "explore" },
        ],
      } as never,
      { cwd: "/tmp", subagentDepth: 0 } as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/0 ok/);
    expect(r.content).toMatch(/\(FAILED\)/);
    expect(r.content).toMatch(/Model not exist/);
  });
});
