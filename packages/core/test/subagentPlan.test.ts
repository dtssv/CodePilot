// Built-in `plan` sub-agent type: a read-only planning agent. It gets explore's
// tool surface (no write/bash/task_board), a plan-structured role block + footer
// in its prompt, defaults to the small model, and omits the memory index. It is
// a reserved built-in, so a custom agent named "plan" does not shadow it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSubagentRunner, SUBAGENT_PLAN_ROLE_BLOCK } from "../src/subagent.js";
import { buildSubagentToolRegistry } from "../src/tools/subagentTools.js";
import type { CodepilotConfig } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

/** A fake OpenAI-compatible model that records each request body (incl. its
 * system message and chosen model). */
function fakeModel(reply: string): Promise<{ server: Server; url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(body));
      } catch {
        bodies.push({ raw: body });
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

describe("plan sub-agent type — role block", () => {
  it("the plan role block names the plan structure and forbids editing", () => {
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toMatch(/Planning Sub-Agent/);
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toContain("### Plan");
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toContain("### Critical files");
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toContain("### Risks");
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toContain("### Open questions");
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toMatch(/read-only/);
    expect(SUBAGENT_PLAN_ROLE_BLOCK).toMatch(/do NOT edit files/);
  });
});

describe("plan sub-agent type — tool surface", () => {
  it("has no write/bash/task_board tools (same as explore)", () => {
    const names = new Set(buildSubagentToolRegistry("plan").all().map((t) => t.name));
    for (const n of ["write_file", "edit_file", "apply_patch", "bash", "task_board"]) {
      expect(names.has(n)).toBe(false);
    }
    for (const n of ["read_file", "grep", "glob", "web_search"]) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe("plan sub-agent type — runner integration", () => {
  let model: Server;
  let url: string;
  let bodies: Record<string, unknown>[];
  let dir: string;

  beforeAll(async () => {
    ({ server: model, url, bodies } = await fakeModel("### Plan\n- step 1"));
    dir = mkdtempSync(join(tempHome, "subplan-"));
    // A project-state memory file the sub-agent would normally index.
    writeFileSync(join(dir, "MEMORY.md"), "# Project memory\nPLAN_TEST_MEMORY_MARKER present\n");
  });
  afterAll(() => {
    model.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeRunner(opts?: { resolvePlanAsCustom?: boolean }) {
    const config = {
      sandbox: { mode: "off" },
      provider: "openai",
      baseURL: url,
      apiKey: "x",
      model: "fake-big",
      smallModel: "fake-small",
    } as unknown as CodepilotConfig;
    return createSubagentRunner({
      cwd: dir,
      config,
      model: "fake-big",
      projectStateDir: () => dir,
      buildToolRegistry: (agentType) => buildSubagentToolRegistry(agentType),
      // Pretend a custom agent named "plan" exists; the built-in must win.
      resolveCustomAgent: opts?.resolvePlanAsCustom
        ? async (name) =>
            name === "plan"
              ? ({ name: "plan", description: "", body: "CUSTOM_PLAN_BODY", path: "", source: "project" } as never)
              : undefined
        : undefined,
    });
  }

  it("prompt carries the plan footer + role block and defaults to the small model", async () => {
    const before = bodies.length;
    await makeRunner().run({ objective: "design the feature", cwd: dir, agentType: "plan", ownerId: "sub_plan_1" });
    const body = bodies[before]!;
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const system = (body.system as string) ?? JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
    const all = JSON.stringify(messages) + String(system);
    // Plan structure advertised in the system prompt…
    expect(all).toContain("Planning Sub-Agent");
    expect(all).toContain("### Critical files");
    // …and the first user message carries the plan footer, not the Findings one.
    expect(all).toMatch(/### Plan \/ ### Critical files \/ ### Risks \/ ### Open questions/);
    // Defaults to the small model (no explicit `model` passed).
    expect(body.model).toBe("fake-small");
  });

  it("omits the project memory index from the plan prompt", async () => {
    const before = bodies.length;
    await makeRunner().run({ objective: "x", cwd: dir, agentType: "plan", ownerId: "sub_plan_2" });
    const body = bodies[before]!;
    const all = JSON.stringify(body);
    expect(all).not.toContain("PLAN_TEST_MEMORY_MARKER");
  });

  it("an explicit model overrides the small-model default", async () => {
    const before = bodies.length;
    await makeRunner().run({
      objective: "x",
      cwd: dir,
      agentType: "plan",
      model: "fake-big",
      ownerId: "sub_plan_3",
    });
    expect(bodies[before]!.model).toBe("fake-big");
  });

  it("is a reserved built-in: a custom agent named 'plan' does not shadow it", async () => {
    const before = bodies.length;
    await makeRunner({ resolvePlanAsCustom: true }).run({
      objective: "x",
      cwd: dir,
      agentType: "plan",
      ownerId: "sub_plan_4",
    });
    const all = JSON.stringify(bodies[before]!);
    // The built-in plan role block is used, not the custom body.
    expect(all).toContain("Planning Sub-Agent");
    expect(all).not.toContain("CUSTOM_PLAN_BODY");
  });
});
