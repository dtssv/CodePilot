// Compact Instructions — session end-to-end. Verifies that the project memory's
// `## Compact Instructions` section and a per-invocation `/compact <focus>`
// argument both reach the summariser's system prompt during a manual compaction.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionsDir } from "../src/session.js";

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cp-compact-instr-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Stub fetch for the summariser SSE and record each request's system prompt. */
function captureSummariser(captured: { systems: string[] }): void {
  const enc = new TextEncoder();
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: string }) => {
    try {
      const body = JSON.parse(init?.body ?? "{}");
      // OpenAI-style: the system message is the first with role "system".
      const sys = Array.isArray(body.messages)
        ? body.messages.find((m: { role?: string }) => m.role === "system")
        : undefined;
      if (sys && typeof sys.content === "string") captured.systems.push(sys.content);
      else if (typeof body.system === "string") captured.systems.push(body.system);
    } catch {
      /* ignore non-JSON bodies */
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"S"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
}

function seedLongHistory(id: string): void {
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `u${i}`,
        role: "user",
        content: [{ type: "text", text: `turn ${i} ${"word ".repeat(40)}` }],
      }),
    );
  }
  const dir = getSessionsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

const baseConfig = {
  provider: "openai" as const,
  apiKey: "k",
  baseURL: "https://example.com/v1",
  model: "gpt-4o",
  smallModel: "gpt-4o-mini",
  maxTokens: 256,
  contextWindow: 400,
  compactionThreshold: 0.5,
};

describe("compact instructions reach the summariser (session)", () => {
  it("includes the project `## Compact Instructions` section", async () => {
    writeFileSync(
      join(workDir, "AGENTS.md"),
      "## Compact Instructions\nAlways keep the list of modified files.\n",
      "utf-8",
    );
    const id = "compact-instr-project";
    seedLongHistory(id);
    const captured = { systems: [] as string[] };
    captureSummariser(captured);
    const session = await createSession({ cwd: workDir, sessionId: id, config: baseConfig });
    await session.compact();
    const joined = captured.systems.join("\n====\n");
    expect(joined).toContain("## Additional Instructions");
    expect(joined).toContain("Always keep the list of modified files.");
    await session.dispose();
  });

  it("includes a per-invocation /compact focus argument", async () => {
    const id = "compact-instr-focus";
    seedLongHistory(id);
    const captured = { systems: [] as string[] };
    captureSummariser(captured);
    const session = await createSession({ cwd: workDir, sessionId: id, config: baseConfig });
    await session.compact("Preserve the open PR number.");
    const joined = captured.systems.join("\n====\n");
    expect(joined).toContain("## Additional Instructions");
    expect(joined).toContain("Preserve the open PR number.");
    await session.dispose();
  });

  it("merges the project section and the focus argument", async () => {
    writeFileSync(
      join(workDir, "AGENTS.md"),
      "## Compact Instructions\nKeep the failing test names.\n",
      "utf-8",
    );
    const id = "compact-instr-both";
    seedLongHistory(id);
    const captured = { systems: [] as string[] };
    captureSummariser(captured);
    const session = await createSession({ cwd: workDir, sessionId: id, config: baseConfig });
    await session.compact("And the chosen migration order.");
    const joined = captured.systems.join("\n====\n");
    expect(joined).toContain("Keep the failing test names.");
    expect(joined).toContain("And the chosen migration order.");
    await session.dispose();
  });

  it("uses no Additional Instructions block when none is configured", async () => {
    const id = "compact-instr-none";
    seedLongHistory(id);
    const captured = { systems: [] as string[] };
    captureSummariser(captured);
    const session = await createSession({ cwd: workDir, sessionId: id, config: baseConfig });
    await session.compact();
    const joined = captured.systems.join("\n====\n");
    expect(joined).not.toContain("## Additional Instructions");
    await session.dispose();
  });
});
