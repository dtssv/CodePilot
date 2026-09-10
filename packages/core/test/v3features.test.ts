// Tests for the second tranche: secret redaction, provider failover, hooks,
// and the ask_user_question / plan_done tool contracts.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets, containsSecretShape } from "../src/redact.js";

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
import { FallbackProvider, isFailoverError } from "../src/providers/fallback.js";
import { HookEngine } from "../src/hooks.js";
import { askUserQuestionTool, planDoneTool } from "../src/tools/ask_user.js";
import { taskTool } from "../src/tools/task.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { ToolContext } from "../src/tools/types.js";
import { resolveSandbox } from "../src/sandbox.js";

describe("redactSecrets", () => {
  it("masks cloud and provider keys", () => {
    const text = "key AKIAIOSFODNN7EXAMPLE then sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv\nghp_abcdefghijklmnopqrstuvwxyz1234";
    expect(redactSecrets(text)).toContain("[REDACTED:aws-access-key]");
    expect(redactSecrets(text)).toContain("[REDACTED:anthropic-key]");
    expect(redactSecrets(text)).toContain("[REDACTED:github-token]");
  });

  it("masks passwords in URLs and env-style output", () => {
    const a = redactSecrets("postgres://user:supersecret@db:5432/x");
    expect(a).toContain("user:[REDACTED:password]@db");
    expect(a).not.toContain("supersecret");
    const b = redactSecrets("DATABASE_PASSWORD=hunter2");
    expect(b).toContain("DATABASE_PASSWORD=[REDACTED]");
    expect(b).not.toContain("hunter2");
  });

  it("masks private key blocks and is idempotent", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    const once = redactSecrets(`before ${pem} after`);
    expect(once).toContain("[REDACTED:private-key]");
    expect(once).not.toContain("BEGIN PRIVATE KEY");
    expect(redactSecrets(once)).toBe(once);
  });

  it("leaves ordinary output alone", () => {
    const text = "npm test passed 42 tests in 1.2s";
    expect(containsSecretShape(text)).toBe(false);
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("isFailoverError / FallbackProvider", () => {
  it("classifies transient vs permanent failures", () => {
    expect(isFailoverError("429 Too Many Requests")).toBe(true);
    expect(isFailoverError("rate limit exceeded")).toBe(true);
    expect(isFailoverError("quota exhausted")).toBe(true);
    expect(isFailoverError("ETIMEDOUT")).toBe(true);
    expect(isFailoverError("invalid_request_error: bad tool schema")).toBe(false);
  });

  function fakeProvider(
    name: string,
    events: StreamEvent[],
    throws?: Error
  ): ChatProvider {
    return {
      name,
      defaultModel: "m",
      smallModel: "s",
      async *stream() {
        if (throws) throw throws;
        for (const e of events) yield e;
      },
    };
  }

  it("fails over before any content is produced", async () => {
    const p = new FallbackProvider([
      fakeProvider("primary", [{ kind: "error", message: "429 rate limited" }]),
      fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "ok" }, { kind: "done", finishReason: "stop" }]),
    ]);
    const out = await collect(p.stream({ model: "m", messages: [] }));
    expect(out.some((e) => e.kind === "text_delta")).toBe(true);
    expect(out.some((e) => e.kind === "error" && /failed/.test(e.message))).toBe(false);
  });

  it("does not switch providers after content was streamed", async () => {
    const p = new FallbackProvider([
      fakeProvider(
        "primary",
        [
          { kind: "text_delta", messageId: "m", text: "partial" },
          { kind: "error", message: "429 rate limited" },
        ]
      ),
      fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "SHOULD NOT APPEAR" }]),
    ]);
    const out = await collect(p.stream({ model: "m", messages: [] }));
    const asText = (e: StreamEvent): boolean =>
      e.kind === "text_delta" && e.text.includes("SHOULD NOT APPEAR");
    expect(out.some((e) => e.kind === "error" && e.message.includes("429"))).toBe(true);
    expect(out.some(asText)).toBe(false);
  });

  it("reports failure when every provider is exhausted", async () => {
    const p = new FallbackProvider([
      fakeProvider("a", [{ kind: "error", message: "429" }]),
      fakeProvider("b", [{ kind: "error", message: "429" }]),
    ]);
    const out = await collect(p.stream({ model: "m", messages: [] }));
    const last = out[out.length - 1]!;
    expect(last.kind).toBe("error");
    expect((last as { message: string }).message).toContain("all providers failed");
  });
});

describe("HookEngine", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cphook-"));
  });

  it("PreToolUse exit 2 blocks the tool call", async () => {
    await mkdir(join(dir, "hooks"), { recursive: true });
    await writeFile(
      join(dir, "hooks", "deny.sh"),
      "#!/bin/sh\ncat > /dev/null\necho 'not allowed' >&2\nexit 2\n"
    );
    const h = new HookEngine({ PreToolUse: [{ matcher: "write_file", command: "sh hooks/deny.sh" }] }, dir);
    const r = await h.runPreToolUse("write_file", { path: "x" });
    expect(r.action).toBe("block");
    expect(r.reason).toContain("not allowed");
  });

  it("matcher is a regex over the tool name", async () => {
    const h = new HookEngine(
      { PreToolUse: [{ matcher: "^write_.*", command: "sh -c 'echo ok'" }] },
      dir
    );
    expect(h.hasHooks("PreToolUse")).toBe(true);
    const ok = await h.runPreToolUse("write_file", {});
    expect(ok.action).toBe("allow");
  });

  it("PostToolUse stdout becomes model feedback", async () => {
    const h = new HookEngine(
      { PostToolUse: [{ matcher: "*", command: "sh -c 'echo lint-fix-needed'" }] },
      dir
    );
    const r = await h.runPostToolUse("bash", {}, "output", false);
    expect(r.feedback).toContain("lint-fix-needed");
  });
});

describe("ask_user_question / plan_done", () => {
  const ctx = (askUser?: ToolContext["askUser"]): ToolContext => ({
    cwd: "/tmp",
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, "/tmp"),
    askUser,
  });

  it("ask_user_question errors gracefully without a host channel", async () => {
    const r = await askUserQuestionTool.execute(
      { questions: [{ id: "q1", question: "which one?" }] },
      ctx()
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no interactive user channel");
  });

  it("ask_user_question returns the host's answers", async () => {
    const r = await askUserQuestionTool.execute(
      { questions: [{ id: "q1", question: "scope?", options: [{ label: "A" }] }] },
      ctx(async (req) => {
        expect(req.questions).toHaveLength(1);
        return { q1: "A" };
      })
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("q1: A");
  });

  it("plan_done emits the exit_plan_mode signal on approval", async () => {
    const r = await planDoneTool.execute({}, ctx(async () => ({ approve: "Approve" })));
    expect(r.content).toContain("approved");
    const sig = JSON.parse(r.blocks![0]!.text) as {
      type: string;
      approved: boolean;
    };
    expect(sig.type).toBe("exit_plan_mode");
    expect(sig.approved).toBe(true);
  });

  it("plan_done stays in plan mode on rejection", async () => {
    const r = await planDoneTool.execute({}, ctx(async () => ({ approve: "Revise" })));
    expect(r.content).toContain("NOT approved");
  });
});

describe("task fan-out schema", () => {
  it("accepts either objective or tasks, never both", () => {
    const s = taskTool.inputSchema;
    expect(s.safeParse({ objective: "do x" }).success).toBe(true);
    expect(s.safeParse({ tasks: [{ objective: "do x" }] }).success).toBe(true);
    expect(s.safeParse({ objective: "do x", tasks: [{ objective: "do y" }] }).success).toBe(false);
  });

  it("returns a per-task error instead of failing the whole call", async () => {
    const t = taskTool as typeof taskTool & { runner?: unknown };
    t.runner = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const ctxx: ToolContext = {
      cwd: "/tmp",
      artifact: async () => "a",
      readArtifact: async () => "",
    };
    const r = await t.execute(
      { tasks: [{ objective: "one" }, { objective: "two" }] },
      ctxx
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Task 1");
    expect(r.content).toContain("Task 2");
  });

  it("exposes a JSON schema that tools/list consumers can read", () => {
    expect(taskTool.name).toBe("task");
    expect(taskTool.description).toContain("fan out");
  });
});
