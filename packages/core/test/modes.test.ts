import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  filterToolsByMode,
  filterToolsByModeFromRegistry,
  filterToolNames,
} from "../src/tools/modes.js";
import {
  ToolRegistry,
  bashTool,
  bashOutputTool,
  bashKillTool,
  writeStdinTool,
  notebookEditTool,
  webFetchTool,
  webSearchTool,
  imageGenTool,
  readFileTool,
  readImageTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  diagnosticsTool,
  globTool,
  grepTool,
  lsTool,
  planUpdateTool,
  memoryWriteTool,
  readArtifactTool,
  askUserQuestionTool,
  planDoneTool,
  startNewTaskTool,
  suggestModeTool,
  startGoalTool,
  taskTool,
  codeModeTool,
  harnessBridgeTool,
} from "../src/tools/index.js";
import type { AgentMode } from "../src/types.js";
import type { ToolDef } from "../src/tools/types.js";

describe("filterToolsByMode", () => {
  it("agent mode returns every tool unchanged (in order)", () => {
    const tools = [
      readFileTool,
      bashTool,
      writeFileTool,
      planUpdateTool,
      memoryWriteTool,
      taskTool,
    ];
    const out = filterToolsByMode(tools, "agent");
    expect(out.map((t) => t.name)).toEqual([
      "read_file",
      "bash",
      "write_file",
      "plan_update",
      "memory_write",
      "task",
    ]);
  });

  it("chat mode keeps only the read-only baseline", () => {
    const tools = [
      readFileTool,
      bashTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      lsTool,
      planUpdateTool,
      memoryWriteTool,
      readArtifactTool,
      taskTool,
    ];
    const names = filterToolNames(tools, "chat").sort();
    expect(names).toEqual(
      ["glob", "grep", "ls", "read_artifact", "read_file"].sort()
    );
  });

  it("chat mode never includes bash/write_file/edit_file/task/plan_update/memory_write", () => {
    const tools = [bashTool, writeFileTool, editFileTool, taskTool, planUpdateTool, memoryWriteTool];
    expect(filterToolNames(tools, "chat")).toEqual([]);
  });

  it("code_mode is allowed in agent but denied in chat and plan (runs bash/writes)", () => {
    const tools = [readFileTool, codeModeTool];
    expect(filterToolNames(tools, "agent")).toContain("code_mode");
    expect(filterToolNames(tools, "chat")).not.toContain("code_mode");
    expect(filterToolNames(tools, "plan")).not.toContain("code_mode");
  });

  it("plan mode keeps read-only + plan_update + memory_write", () => {
    const tools = [
      readFileTool,
      bashTool,
      writeFileTool,
      editFileTool,
      globTool,
      grepTool,
      lsTool,
      planUpdateTool,
      memoryWriteTool,
      readArtifactTool,
      taskTool,
    ];
    const names = filterToolNames(tools, "plan").sort();
    expect(names).toEqual(
      [
        "glob",
        "grep",
        "ls",
        "memory_write",
        "plan_update",
        "read_artifact",
        "read_file",
      ].sort()
    );
  });

  it("plan mode forbids bash/write_file/edit_file/task", () => {
    const tools = [bashTool, writeFileTool, editFileTool, taskTool];
    expect(filterToolNames(tools, "plan")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const tools = [readFileTool, bashTool];
    const before = [...tools];
    filterToolsByMode(tools, "chat");
    expect(tools).toEqual(before);
  });

  it("returns read-tier MCP tools in restricted modes", () => {
    const mcpRead: ToolDef = {
      name: "mcp__docs__search",
      description: "search the docs",
      inputSchema: z.object({ q: z.string() }),
      permission: "read",
      async execute() {
        return { content: "ok" };
      },
    };
    const mcpNet: ToolDef = {
      name: "mcp__x__post",
      description: "post x",
      inputSchema: z.object({}),
      permission: "network",
      async execute() {
        return { content: "ok" };
      },
    };
 // Chat: keep read-tier MCP, drop network-tier MCP.
    const chat = filterToolsByMode([mcpRead, mcpNet], "chat").map((t) => t.name);
    expect(chat).toEqual(["mcp__docs__search"]);
 // Agent: keep everything.
    const agent = filterToolsByMode([mcpRead, mcpNet], "agent").map((t) => t.name);
    expect(agent).toEqual(["mcp__docs__search", "mcp__x__post"]);
  });
});

// Drift guard: the four curated name sets in modes.ts (READ_TOOLS /
// PLAN_ONLY_TOOLS / ALWAYS_DENIED / CHAT_DENIED) are hand-maintained string
// lists. A built-in not named in any of them falls through to the
// `permission === "read"` default. That default is SAFE (write/execute/network
// tools are dropped in restricted modes; read tools are kept), but nothing
// otherwise pins it — a future tool added with the wrong tier, or an explicit
// list that drifts from a tool's real permission, would silently mis-gate.
// This block pins the whole-table invariant so that can't happen unnoticed.
describe("mode gating is consistent with each built-in's permission tier", () => {
  // Every module-singleton built-in tool (the ones registered by
  // Session.registerBuiltins that are exported as statics). Per-session tools
  // built inside the session (skill, lsp_navigate, mcp meta) are covered by
  // their permission tier via the MCP/read cases above.
  const builtins: ToolDef[] = [
    bashTool,
    bashOutputTool,
    bashKillTool,
    writeStdinTool,
    notebookEditTool,
    webFetchTool,
    webSearchTool,
    imageGenTool,
    readFileTool,
    readImageTool,
    writeFileTool,
    editFileTool,
    applyPatchTool,
    diagnosticsTool,
    globTool,
    grepTool,
    lsTool,
    planUpdateTool,
    memoryWriteTool,
    readArtifactTool,
    askUserQuestionTool,
    planDoneTool,
    startNewTaskTool,
    suggestModeTool,
    startGoalTool,
    taskTool,
    codeModeTool,
    harnessBridgeTool,
  ];

  it("agent mode exposes every built-in", () => {
    const names = filterToolNames(builtins, "agent").sort();
    expect(names).toEqual(builtins.map((t) => t.name).sort());
  });

  // Non-read built-ins that are INTENTIONALLY allow-listed in a restricted
  // mode (they live in modes.ts's READ_TOOLS/PLAN_ONLY_TOOLS by name). Any
  // non-read tool exposed in chat/plan must be on this list — otherwise it is
  // drift (a tool silently escaping its tier), and the test fails.
  const EXPLICIT_RESTRICTED_EXCEPTIONS: Record<AgentMode, ReadonlySet<string>> = {
    // web_fetch / web_search are network-tier but deliberately offered as
    // read-like research tools in every mode. (memory_write is read-tier, so it
    // never reaches this non-read assertion; its plan allowance is pinned by
    // the existing "plan mode keeps … memory_write" test above.)
    chat: new Set(["web_fetch", "web_search"]),
    plan: new Set(["web_fetch", "web_search"]),
    agent: new Set(),
  };

  for (const mode of ["chat", "plan"] as AgentMode[]) {
    it(`never exposes a write/execute/network built-in in ${mode} mode except explicit allow-list members`, () => {
      const visible = new Set(filterToolNames(builtins, mode));
      const allowed = EXPLICIT_RESTRICTED_EXCEPTIONS[mode];
      for (const t of builtins) {
        if (t.permission === "read") continue;
        if (!visible.has(t.name)) continue;
        expect(
          allowed.has(t.name),
          `${t.name} (${t.permission}) is exposed in ${mode} mode but is not a documented allow-list member — ` +
            `either it drifted out of modes.ts or a new tool needs classifying`,
        ).toBe(true);
      }
    });
  }

  it("keeps every read-tier built-in in chat mode except the deliberately chat-denied ones", () => {
    // read-tier tools are the safe baseline. Three read-tier tools are
    // nonetheless denied in chat — the key insight that the permission axis
    // (approval) and the mode axis (collaboration restriction) are ORTHOGONAL,
    // and these are exactly where they diverge:
    //   - plan_update:  records a planning event; chat wants answers, not plans.
    //   - memory_write: writes memory files — a side effect chat policy forbids.
    //   - task:         read on the approval axis, but spawns sub-agents that
    //                   can write/execute, so it is ALWAYS_DENIED in restricted
    //                   modes (a broad side-effect risk).
    // Pin that the fall-through keeps every OTHER read tool, so a future read
    // tool is never accidentally hidden from chat.
    const CHAT_DENIED_READ = new Set(["plan_update", "memory_write", "task"]);
    const chat = new Set(filterToolNames(builtins, "chat"));
    for (const t of builtins) {
      if (t.permission !== "read") continue;
      if (CHAT_DENIED_READ.has(t.name)) {
        expect(chat.has(t.name), `${t.name} should be chat-denied`).toBe(false);
        continue;
      }
      expect(
        chat.has(t.name),
        `read-tier ${t.name} should be available in chat mode`,
      ).toBe(true);
    }
  });
});

describe("filterToolsByModeFromRegistry", () => {
  it("reflects the registry's tools (with filtering)", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    r.register(bashTool);
    r.register(planUpdateTool);
    expect(filterToolNames(r.all(), "chat").sort()).toEqual(["read_file"]);
    expect(filterToolNames(r.all(), "plan").sort()).toEqual([
      "plan_update",
      "read_file",
    ]);
    expect(filterToolNames(r.all(), "agent").sort()).toEqual([
      "bash",
      "plan_update",
      "read_file",
    ]);
  });

  it("convenience helper agrees with the raw function", () => {
    const r = new ToolRegistry();
    r.register(readFileTool);
    r.register(writeFileTool);
    r.register(memoryWriteTool);
    expect(filterToolsByModeFromRegistry(r, "plan").map((t) => t.name)).toEqual(
      filterToolsByMode(r.all(), "plan").map((t) => t.name)
    );
  });
});