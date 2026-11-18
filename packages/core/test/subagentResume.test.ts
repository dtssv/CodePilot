// Sub-agent continuation: a second run with resumeSessionId replays the prior
// transcript as history (the model sees what it already did) and sends the
// follow-up WITHOUT the "you are a sub-agent" objective preamble, rather than
// starting the task over. Also verifies the transcript is persisted per id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSubagentRunner } from "../src/subagent/subagent.js";
import { SubagentStore } from "../src/subagent/subagentStore.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { CodepilotConfig } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

/** A fake OpenAI-compatible model that records each request body and replies
 * with a fixed assistant message. */
function fakeModel(reply: string): Promise<{ server: Server; url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push(body);
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(chunk({ role: "assistant", content: reply }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ server, url: `http://127.0.0.1:${port}/v1`, bodies });
    }),
  );
}

describe("sub-agent continuation (resume)", () => {
  let model: Server;
  let url: string;
  let bodies: unknown[];
  let dir: string;

  beforeAll(async () => {
    ({ server: model, url, bodies } = await fakeModel("### Findings\n- did the thing"));
    dir = mkdtempSync(join(tempHome, "subres-"));
  });
  afterAll(() => {
    model.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRunner() {
    const config = {
      sandbox: { mode: "off" },
      provider: "openai",
      baseURL: url,
      apiKey: "x",
      model: "fake",
      smallModel: "fake",
    } as unknown as CodepilotConfig;
    return createSubagentRunner({
      cwd: dir,
      config,
      model: "fake",
      projectStateDir: () => dir,
      buildToolRegistry: () => new ToolRegistry(),
    });
  }

  it("persists a transcript, then continues it without re-sending the objective preamble", async () => {
    const runner = makeRunner();
    const id = "sub_resume_test";

    // Fresh run: the first request must carry the task + conclusion footer.
    // (ok is irrelevant here — the fake model takes no tool steps, which the
    // outcome assessor flags as a soft failure; we only care about resume.)
    const r1 = await runner.run({ objective: "analyze module X", cwd: dir, ownerId: id });
    expect(r1.sessionId).toBe(id);

    const firstBody = bodies[0] as {
      messages: Array<{ role: string; content: unknown }>;
      prompt_cache_key?: string;
    };
    const firstUser = firstBody.messages.find((m) => m.role === "user");
    expect(JSON.stringify(firstUser!.content)).toMatch(/analyze module X/);
    expect(JSON.stringify(firstUser!.content)).toMatch(/### Findings/);
    expect(JSON.stringify(firstUser!.content)).not.toMatch(/OBJECTIVE:/);
    // OpenAI-compat cache affinity must be the sub-agent owner id — otherwise
    // later turns of the same child never report cache hits (CCR cache_read=0).
    expect(firstBody.prompt_cache_key).toBe(id);

    // The transcript was persisted under the owner id.
    const store = new SubagentStore(dir);
    const persisted = await store.load(id);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.some((e) => e.type === "message" && e.role === "assistant")).toBe(true);

    const callsBefore = bodies.length;

    // Continue the SAME sub-agent: the follow-up must NOT re-attach the
    // conclusion footer, and the request must include prior transcript.
    const r2 = await runner.run({
      objective: "now also check module Y",
      cwd: dir,
      ownerId: id,
      resumeSessionId: id,
    });
    expect(r2.sessionId).toBe(id);

    const resumeBody = bodies[callsBefore] as {
      messages: Array<{ role: string; content: unknown }>;
      prompt_cache_key?: string;
    };
    // History replayed: more than a single user turn (prior assistant message
    // is present). The follow-up is a bare user turn; trailing runtime_context
    // stays a separate demoted user (not merged) for prefix-cache stability.
    const userMsgs = resumeBody.messages.filter((m) => m.role === "user");
    const followUp = userMsgs.find((m) => /now also check module Y/.test(JSON.stringify(m.content)));
    expect(followUp).toBeTruthy();
    expect(JSON.stringify(followUp!.content)).not.toMatch(/### Findings/);
    expect(JSON.stringify(userMsgs[userMsgs.length - 1]!.content)).toMatch(/runtime_context/);
    expect(resumeBody.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(resumeBody.prompt_cache_key).toBe(id);

    // The store now holds both runs' events (appended, not replaced).
    const after = await store.load(id);
    expect(after.length).toBeGreaterThan(persisted.length);
  });

  it("live-emits bare task text without the conclusion footer (footer is model-only)", async () => {
    const live: unknown[] = [];
    const before = bodies.length;
    await makeRunner().run({
      objective: "ping baidu.com",
      cwd: dir,
      ownerId: "sub_ui_objective",
      onLiveEvent: (e) => live.push(e),
    });
    // Provider request still carries the full footer for the model.
    const req = bodies[before] as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(req.messages)).toMatch(/ping baidu\.com/);
    expect(JSON.stringify(req.messages)).toMatch(/### Findings/);
    expect(JSON.stringify(req.messages)).not.toMatch(/OBJECTIVE:/);
    // Nested UI stream: first live message is bare task only (no Findings footer).
    const firstUser = live.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string; role?: string }).type === "message" &&
        (e as { role?: string }).role === "user",
    ) as { content?: Array<{ text?: string }> } | undefined;
    const uiText = firstUser?.content?.map((b) => b.text ?? "").join("") ?? "";
    expect(uiText).toBe("ping baidu.com");
    expect(uiText).not.toContain("### Findings");
  });

  it("bash-only worker skips AGENTS.md; file-mutating worker keeps it", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "AGENTS.md"), "WORKER_AGENTS_MARKER: run pnpm test\n", "utf-8");
    const { buildSubagentToolRegistry } = await import("../src/tools/subagentTools.js");
    const config = {
      sandbox: { mode: "off" },
      provider: "openai",
      baseURL: url,
      apiKey: "x",
      model: "fake",
      smallModel: "fake",
    } as unknown as CodepilotConfig;
    const runner = createSubagentRunner({
      cwd: dir,
      config,
      model: "fake",
      projectStateDir: () => dir,
      buildToolRegistry: (agentType) => buildSubagentToolRegistry(agentType),
    });

    const beforeBash = bodies.length;
    await runner.run({
      objective: "ping something",
      cwd: dir,
      agentType: "worker",
      tools: ["bash"],
      ownerId: "sub_bash_only",
    });
    expect(JSON.stringify(bodies[beforeBash])).not.toContain("WORKER_AGENTS_MARKER");

    const beforeWrite = bodies.length;
    await runner.run({
      objective: "edit a file",
      cwd: dir,
      agentType: "worker",
      tools: ["edit_file", "read_file"],
      ownerId: "sub_edit_worker",
    });
    expect(JSON.stringify(bodies[beforeWrite])).toContain("WORKER_AGENTS_MARKER");
  });
});
