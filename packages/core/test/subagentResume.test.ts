// Sub-agent continuation: a second run with resumeSessionId replays the prior
// transcript as history (the model sees what it already did) and sends the
// follow-up WITHOUT the "you are a sub-agent" objective preamble, rather than
// starting the task over. Also verifies the transcript is persisted per id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSubagentRunner } from "../src/subagent.js";
import { SubagentStore } from "../src/subagentStore.js";
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

    // Fresh run: the first request must carry the OBJECTIVE preamble. (ok is
    // irrelevant here — the fake model takes no tool steps, which the outcome
    // assessor flags as a soft failure; we only care about resume mechanics.)
    const r1 = await runner.run({ objective: "analyze module X", cwd: dir, ownerId: id });
    expect(r1.sessionId).toBe(id);

    const firstBody = bodies[0] as { messages: Array<{ role: string; content: unknown }> };
    const firstUser = firstBody.messages.find((m) => m.role === "user");
    expect(JSON.stringify(firstUser!.content)).toMatch(/OBJECTIVE:/);

    // The transcript was persisted under the owner id.
    const store = new SubagentStore(dir);
    const persisted = await store.load(id);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.some((e) => e.type === "message" && e.role === "assistant")).toBe(true);

    const callsBefore = bodies.length;

    // Continue the SAME sub-agent: the follow-up must NOT carry the OBJECTIVE
    // preamble, and the request must include the prior transcript as history.
    const r2 = await runner.run({
      objective: "now also check module Y",
      cwd: dir,
      ownerId: id,
      resumeSessionId: id,
    });
    expect(r2.sessionId).toBe(id);

    const resumeBody = bodies[callsBefore] as { messages: Array<{ role: string; content: unknown }> };
    // History replayed: more than a single user turn (prior assistant message
    // is present), and the latest user message is the bare follow-up.
    const userMsgs = resumeBody.messages.filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1]!;
    expect(JSON.stringify(lastUser.content)).toMatch(/now also check module Y/);
    expect(JSON.stringify(lastUser.content)).not.toMatch(/OBJECTIVE:/);
    expect(resumeBody.messages.some((m) => m.role === "assistant")).toBe(true);

    // The store now holds both runs' events (appended, not replaced).
    const after = await store.load(id);
    expect(after.length).toBeGreaterThan(persisted.length);
  });
});
