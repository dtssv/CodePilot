import { describe, expect, it } from "vitest";

import type { Row, ToolRow } from "../src/ui/state.js";
import { initialState, reducer, rowKeys, settledCount } from "../src/ui/state.js";
import { bashCommand, editDiff, resultPreview, toolLabel, toolSubject } from "../src/ui/toolDisplay.js";
import { detailLines, viewerTools } from "../src/ui/ToolViewer.js";
import { textWidth, wrapLine } from "../src/ui/textWidth.js";
import type { Event } from "@codepilot/core";

function tool(partial: Partial<ToolRow> & Pick<ToolRow, "id" | "name" | "category">): ToolRow {
  return {
    inputSummary: "",
    target: "",
    status: "ok",
    ...partial,
  };
}

function run(events: Event[], busy = true) {
  let s = initialState({ sessionId: "s1", cwd: "/w", model: "m", permissionMode: "ask", agentMode: "agent" });
  if (busy) s = reducer(s, { type: "set-busy", busy: true });
  for (const event of events) s = reducer(s, { type: "event", event });
  return s;
}

describe("toolDisplay", () => {
  it("labels and subjects", () => {
    const bash = tool({
      id: "1",
      name: "bash",
      category: "bash",
      input: { command: "echo hi\nls" },
      target: "echo hi",
    });
    expect(toolLabel(bash)).toBe("Bash");
    expect(bashCommand(bash)).toBe("echo hi\nls");
    expect(
      toolSubject(
        tool({
          id: "2",
          name: "task",
          category: "task",
          input: { objective: "look around", agent_type: "explore" },
          target: "look around",
        }),
      ),
    ).toBe("look around");
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Add File: src/b.ts",
      "*** End Patch",
    ].join("\n");
    expect(
      toolLabel(
        tool({
          id: "3",
          name: "apply_patch",
          category: "edit",
          input: { patch },
          target: "src/a.ts · + src/b.ts",
        }),
      ),
    ).toBe("Update");
    expect(
      toolLabel(
        tool({
          id: "4",
          name: "apply_patch",
          category: "edit",
          input: { patch: "*** Begin Patch\n*** Add File: n.ts\n*** End Patch" },
          target: "+ n.ts",
        }),
      ),
    ).toBe("Write");
  });

  it("previews bash output and edit diffs", () => {
    const bash = tool({
      id: "b",
      name: "bash",
      category: "bash",
      status: "ok",
      resultText: "a\nb\nc\nd\ne\n",
      target: "x",
    });
    expect(resultPreview(bash, 3)).toEqual({ lines: ["a", "b", "c"], hidden: 2, tone: "normal" });
    const edit = tool({
      id: "e",
      name: "edit_file",
      category: "edit",
      input: { path: "a.ts", search: "old\nline", replace: "new\nline\nextra" },
      target: "a.ts",
    });
    const diff = editDiff(edit);
    expect(diff.lines.some((l) => l.sign === "-" && l.text.includes("old"))).toBe(true);
    expect(diff.lines.some((l) => l.sign === "+" && l.text.includes("extra"))).toBe(true);
  });
});

describe("textWidth", () => {
  it("counts CJK as two cells and hard-wraps", () => {
    expect(textWidth("中文ab")).toBe(6);
    expect(wrapLine("中文ab中文", 5)).toEqual(["中文a", "b中文"]);
  });
});

describe("reducer: user upsert + subagent", () => {
  it("upserts a user message with the same id", () => {
    const s = run([
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go final" }] },
    ]);
    expect(s.rows.filter((r) => r.kind === "user")).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: "user", text: "go final" });
  });

  it("nests sub-agent steps under the parent task, including out-of-order results", () => {
    const s = run([
      { type: "tool_call", id: "c2", name: "task", input: { objective: "SUBTASK", agent_type: "explore" } },
      { type: "subagent", parentToolCallId: "c2", index: 0, objective: "SUBTASK", state: "running", sessionId: "sub_1", runSeq: 1 },
      {
        type: "subagent",
        parentToolCallId: "c2",
        index: 0,
        objective: "SUBTASK",
        event: { type: "tool_result", toolCallId: "s3", name: "bash", content: "unknown tool: bash", isError: true },
      },
      {
        type: "subagent",
        parentToolCallId: "c2",
        index: 0,
        objective: "SUBTASK",
        event: { type: "tool_call", id: "s3", name: "bash", input: { command: "wc -l README.md" } },
      },
      {
        type: "subagent",
        parentToolCallId: "c2",
        index: 0,
        objective: "SUBTASK",
        event: { type: "message_delta", messageId: "m", delta: { type: "text", text: "Found " } },
      },
      {
        type: "subagent",
        parentToolCallId: "c2",
        index: 0,
        objective: "SUBTASK",
        event: { type: "message_delta", messageId: "m", delta: { type: "text", text: "it." } },
      },
      {
        type: "subagent",
        parentToolCallId: "c2",
        index: 0,
        objective: "SUBTASK",
        event: { type: "message", id: "m", role: "assistant", content: [{ type: "text", text: "Found it." }] },
      },
      { type: "subagent", parentToolCallId: "c2", index: 0, objective: "SUBTASK", state: "ok" },
    ]);
    const task = s.rows.find((r) => r.kind === "tool" && r.tool.id === "c2");
    expect(task?.kind).toBe("tool");
    if (task?.kind !== "tool") return;
    expect(task.tool.subagents).toHaveLength(1);
    const run0 = task.tool.subagents![0]!;
    expect(run0.state).toBe("ok");
    expect(run0.objective).toBe("SUBTASK");
    expect(run0.text).toBe("Found it.");
    expect(run0.steps).toHaveLength(1);
    expect(run0.steps[0]).toMatchObject({ id: "s3", status: "error", target: "wc -l README.md" });
  });

  it("holds the trailing user bubble and streaming rows out of the settled prefix", () => {
    const streaming = run([
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "go" }] },
      { type: "message_delta", messageId: "a1", delta: { type: "text", text: "hi" } },
    ]);
    expect(settledCount(streaming.rows, true)).toBe(1);
    expect(rowKeys(streaming.rows)[0]).toBe("u:u1");
    const idle: Row[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", msg: { id: "a1", role: "assistant", text: "hi", streaming: false } },
    ];
    expect(settledCount(idle, false)).toBe(2);
  });
});

describe("ToolViewer", () => {
  it("lists tools and expands a sub-agent", () => {
    const rows: Row[] = [
      {
        kind: "tool",
        tool: tool({
          id: "t1",
          name: "task",
          category: "task",
          target: "SUBTASK",
          input: { objective: "SUBTASK", agent_type: "explore" },
          subagents: [
            {
              index: 0,
              objective: "SUBTASK",
              state: "ok",
              steps: [tool({ id: "s1", name: "ls", category: "list", target: ".", resultText: "- a", status: "ok" })],
              text: "Found a.",
            },
          ],
        }),
      },
    ];
    expect(viewerTools(rows)).toHaveLength(1);
    const lines = detailLines(rows[0]!.tool, 60);
    expect(lines.some((l) => /Sub-agent/.test(l.text))).toBe(true);
    expect(lines.some((l) => /Found a/.test(l.text))).toBe(true);
  });
});
