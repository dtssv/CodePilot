// task tool `context: "fork"`: a sub-agent can inherit a copy of the parent's
// model-visible history as a prefix (so it sees what the parent already read),
// instead of starting fresh. Default stays fresh; fork + continue_session_id is
// rejected. Spec-level tests assert the fields thread through; a provider-message
// test proves the parent prefix actually reaches the sub-agent's request while
// the OBJECTIVE preamble is still present.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskTool, type SubagentRunSpec, type SubagentRunResult } from "../src/tools/task.js";
import { createSubagentRunner } from "../src/subagent.js";
import { ToolRegistry } from "../src/tools/types.js";
import type { Event, CodepilotConfig } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

function makeMockRunner() {
  const specs: SubagentRunSpec[] = [];
  return {
    specs,
    runner: {
      async run(spec: SubagentRunSpec): Promise<SubagentRunResult> {
        specs.push(spec);
        return {
          conclusion: `conclusion for ${spec.objective}`,
          steps: 1,
          ok: true,
          sessionId: spec.ownerId ?? spec.resumeSessionId,
        };
      },
    },
  };
}

function ctxWith(events: Event[]) {
  return {
    cwd: "/tmp",
    subagentDepth: 0,
    toolCallId: "call_1",
    emitEvent: (e: Event) => {
      events.push(e);
    },
  };
}

function resetTool() {
  taskTool._sem = undefined;
  taskTool._spawned = 0;
  taskTool._runSeq = 0;
}

describe("task tool — context fork (spec wiring)", () => {
  it("threads context:\"fork\" and fork_max_tokens into the spec", async () => {
    const mock = makeMockRunner();
    taskTool.runner = mock.runner;
    resetTool();
    const events: Event[] = [];
    await taskTool.execute(
      { objective: "use the context", context: "fork", fork_max_tokens: 8000 } as never,
      ctxWith(events) as never,
    );
    expect(mock.specs).toHaveLength(1);
    expect(mock.specs[0]!.context).toBe("fork");
    expect(mock.specs[0]!.forkMaxTokens).toBe(8000);
  });

  it("defaults to fresh (no context on the spec)", async () => {
    const mock = makeMockRunner();
    taskTool.runner = mock.runner;
    resetTool();
    const events: Event[] = [];
    await taskTool.execute({ objective: "plain" } as never, ctxWith(events) as never);
    expect(mock.specs[0]!.context).toBeUndefined();
  });

  it("rejects context:\"fork\" together with continue_session_id", async () => {
    const mock = makeMockRunner();
    taskTool.runner = mock.runner;
    resetTool();
    const events: Event[] = [];
    const r = await taskTool.execute(
      { objective: "x", context: "fork", continue_session_id: "sub_abc" } as never,
      ctxWith(events) as never,
    );
    expect(r.isError).toBe(true);
    // The runner must not have been invoked for an invalid request.
    expect(mock.specs).toHaveLength(0);
  });
});

/** A fake OpenAI-compatible model that records each request body. */
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

describe("sub-agent context fork (provider messages)", () => {
  let model: Server;
  let url: string;
  let bodies: unknown[];
  let dir: string;

  beforeAll(async () => {
    ({ server: model, url, bodies } = await fakeModel("### Findings\n- ok"));
    dir = mkdtempSync(join(tempHome, "subfork-"));
  });
  afterAll(() => {
    model.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRunner(parentEvents: Event[]) {
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
      getParentEvents: () => parentEvents.slice(),
    });
  }

  const parentHistory: Event[] = [
    {
      type: "message",
      id: "pu1",
      role: "user",
      content: [{ type: "text", text: "PARENT_MARKER_read file alpha.ts" }],
    },
    {
      type: "message",
      id: "pa1",
      role: "assistant",
      content: [{ type: "text", text: "alpha.ts exports foo()" }],
    },
  ];

  it("fork seeds the parent prefix AND keeps the OBJECTIVE preamble", async () => {
    const before = bodies.length;
    const runner = makeRunner(parentHistory);
    await runner.run({ objective: "use alpha", cwd: dir, ownerId: "sub_fork_1", context: "fork" });
    const body = bodies[before] as { messages: Array<{ role: string; content: unknown }> };
    const all = JSON.stringify(body.messages);
    // The parent's prior content is inherited…
    expect(all).toMatch(/PARENT_MARKER_read file alpha.ts/);
    // …with the inherited-context marker…
    expect(all).toMatch(/inherited context from the parent/);
    // …and the sub-agent's own objective preamble is still present.
    expect(all).toMatch(/OBJECTIVE:/);
    expect(all).toMatch(/use alpha/);
  });

  it("fresh (no context) does NOT seed the parent prefix", async () => {
    const before = bodies.length;
    const runner = makeRunner(parentHistory);
    await runner.run({ objective: "standalone", cwd: dir, ownerId: "sub_fresh_1" });
    const body = bodies[before] as { messages: Array<{ role: string; content: unknown }> };
    const all = JSON.stringify(body.messages);
    expect(all).not.toMatch(/PARENT_MARKER_read file alpha.ts/);
    expect(all).toMatch(/OBJECTIVE:/);
  });
});
