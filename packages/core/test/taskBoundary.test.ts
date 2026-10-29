// Task-boundary primitive: clearWorkingContext archives prior context and
// continues the same session with a clean slate (generic, explicit-trigger).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, getSessionsDir } from "../src/session.js";
import type { Event } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

function fakeModel(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(
        chunk({ role: "assistant", content: "ok done with this task." }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ server, url: `http://127.0.0.1:${port}/v1` });
    }),
  );
}

describe("clearWorkingContext (task boundary)", () => {
  let model: Server;
  let url: string;
  let workDir: string;

  beforeAll(async () => {
    ({ server: model, url } = await fakeModel());
    workDir = mkdtempSync(join(tempHome, "taskb-"));
  });
  afterAll(() => {
    model.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function newSession(id: string) {
    return createSession({
      cwd: workDir,
      sessionId: id,
      model: "fake",
      config: {
        sandbox: { mode: "off" },
        providers: {
          fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] },
        },
      } as never,
    });
  }

  it("is a no-op when there is no prior task work", async () => {
    const session = await newSession("taskb-empty");
    const cleared = await session.clearWorkingContext();
    expect(cleared).toBe(false);
  });

  it("archives prior context and leaves a clean slate with a boundary marker", async () => {
    const session = await newSession("taskb-clear");
    await session.prompt("do task A");
    const before = session.getEvents();
    expect(before.some((e) => e.type === "message" && e.role === "assistant")).toBe(true);

    const cleared = await session.clearWorkingContext("finished A; next is unrelated");
    expect(cleared).toBe(true);

    const after = session.getEvents();
    // Live context no longer contains task A's assistant turn verbatim.
    const hasOldAssistant = after.some(
      (e) =>
        e.type === "message" &&
        e.role === "assistant" &&
        e.content.some((b) => b.type === "text" && b.text.includes("ok done with this task")),
    );
    expect(hasOldAssistant).toBe(false);
    // A boundary marker is present as the clean-slate anchor.
    const hasBoundary = after.some(
      (e) =>
        e.type === "message" &&
        e.content.some((b) => b.type === "text" && b.text.includes("[task boundary]")),
    );
    expect(hasBoundary).toBe(true);

    // Full history is still retained for the UI / resume (not lost).
    const history = session.getHistory();
    const keptOld = history.some(
      (e: Event) =>
        e.type === "message" &&
        e.role === "user" &&
        e.content.some((b) => b.type === "text" && b.text.includes("do task A")),
    );
    expect(keptOld).toBe(true);
  });
});
