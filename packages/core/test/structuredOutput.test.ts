import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { streamOnce } from "../src/agent-messages.js";
import type { AgentDeps } from "../src/agent.js";
import { PermissionEngine } from "../src/permissions.js";
import { ArtifactStore } from "../src/tools/artifacts.js";
import { ToolRegistry } from "../src/tools/types.js";
import type {
  ChatProvider,
  ProviderMessage,
  StreamChatOptions,
  StreamEvent,
} from "../src/providers/types.js";

// Captures the options a single provider.stream() call receives.
class CaptureProvider implements ChatProvider {
  readonly name = "openai";
  defaultModel = "m";
  smallModel = "m";
  last: StreamChatOptions | null = null;
  async *stream(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    this.last = opts;
    yield { kind: "done", finishReason: "stop" };
  }
}

describe("streamOnce responseFormat passthrough", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function baseDeps(provider: ChatProvider, extra: Partial<AgentDeps>): AgentDeps {
    dir = mkdtempSync(join(tmpdir(), "streamonce-"));
    return {
      provider,
      tools: new ToolRegistry(),
      artifacts: new ArtifactStore(join(dir, "artifacts")),
      permissions: new PermissionEngine({ permissionMode: "auto-edit" }),
      config: { provider: "openai", model: "gpt-4o" },
      cwd: dir,
      ...extra,
    };
  }

  const messages: ProviderMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];

  it("forwards deps.responseFormat to the provider", async () => {
    const provider = new CaptureProvider();
    const deps = baseDeps(provider, {
      responseFormat: {
        name: "subagent_result",
        schema: { type: "object", properties: { answer: { type: "string" } } },
        strict: false,
      },
    });
    for await (const _ of streamOnce(provider, deps, messages, [], "mid")) void _;
    expect(provider.last?.responseFormat).toEqual({
      name: "subagent_result",
      schema: { type: "object", properties: { answer: { type: "string" } } },
      strict: false,
    });
  });

  it("omits responseFormat when deps does not set it", async () => {
    const provider = new CaptureProvider();
    const deps = baseDeps(provider, {});
    for await (const _ of streamOnce(provider, deps, messages, [], "mid")) void _;
    expect(provider.last?.responseFormat).toBeUndefined();
  });
});
