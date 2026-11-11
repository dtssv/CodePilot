// K-C4-1: artifacts and the audit input summary must pass through the same
// secret-redaction floor as transcript tool results. Here the tool spills a
// large secret-bearing body via spillHeadTail; the on-disk artifact must not
// contain the raw credential.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { runAgent } from "../src/agent.js";
import type { AgentDeps } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { ToolContext } from "../src/tools/types.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { spillHeadTail, ARTIFACT_THRESHOLD } from "../src/tools/_shared.js";
import { PermissionEngine } from "../src/permissions.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";

class ToolThenDoneProvider implements ChatProvider {
  readonly name = "mock";
  defaultModel = "mock-large";
  smallModel = "mock-small";
  private idx = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    const i = this.idx++;
    if (i === 0) {
      yield { kind: "tool_call", toolCall: { id: "t1", name: "leak", input: {} } };
      yield { kind: "done", finishReason: "tool_calls" };
      return;
    }
    yield { kind: "text_delta", messageId: "m", text: "done" };
    yield { kind: "done", finishReason: "stop" };
  }
}

describe("artifact spill redaction (K-C4-1)", () => {
  it("redacts secrets before writing a spilled artifact to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artredact-"));
    const artRoot = join(dir, "artifacts");
    const token = "sk-ant-abcdef0123456789abcdef0123";
    // A body well over the spill threshold with a secret in the head.
    const body = `leading line with ${token}\n` + "filler ".repeat(ARTIFACT_THRESHOLD);

    const tools = new ToolRegistry();
    tools.register({
      name: "leak",
      description: "spills a large secret-bearing output",
      inputSchema: z.object({}),
      permission: "read",
      async execute(_input: unknown, ctx: ToolContext) {
        const r = await spillHeadTail(ctx, body, "leak:test");
        return { content: r.content, artifactRef: r.artifactRef };
      },
    } as never);

    const deps: AgentDeps = {
      provider: new ToolThenDoneProvider(),
      tools,
      artifacts: new ArtifactStore(artRoot),
      permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
      config: { provider: "anthropic" },
      cwd: dir,
      maxTurns: 5,
      systemPrompt: { staticPrefix: "SYS", dynamicSuffix: "" },
      onEvent: () => {},
    };

    await runAgent({ history: [], userText: "go" }, deps);

    const files = readdirSync(artRoot).filter((f) => f.endsWith(".txt"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const onDisk = files.map((f) => readFileSync(join(artRoot, f), "utf-8")).join("");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain("REDACTED");

    rmSync(dir, { recursive: true, force: true });
  });
});
