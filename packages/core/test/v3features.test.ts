// Tests for the second tranche: secret redaction, provider failover, hooks,
// and the ask_user_question / plan_done tool contracts.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets, containsSecretShape, compileRedactionPatterns } from "../src/redact.js";

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

describe("configurable redaction patterns (redact.patterns)", () => {
  it("applies deployment patterns on top of the built-in floor", () => {
    const extra = compileRedactionPatterns([
      { name: "acme-token", regex: "acme-tok-[A-Za-z0-9]{8,}" },
    ]);
    const text = "internal acme-tok-ABCDEFGH1234 alongside ghp_abcdefghijklmnopqrstuvwxyz1234";
    const out = redactSecrets(text, extra);
    // deployment pattern redacted…
    expect(out).toContain("[REDACTED:acme-token]");
    expect(out).not.toContain("acme-tok-ABCDEFGH1234");
    // …and the built-in floor still runs.
    expect(out).toContain("[REDACTED:github-token]");
  });

  it("honours a custom replacement and extra flags", () => {
    const extra = compileRedactionPatterns([
      { name: "ticket", regex: "JIRA-\\d+", flags: "i", replace: "<ticket>" },
    ]);
    expect(redactSecrets("see jira-42 and JIRA-99", extra)).toBe("see <ticket> and <ticket>");
  });

  it("forces the global flag so every occurrence is redacted", () => {
    const extra = compileRedactionPatterns([{ name: "x", regex: "zzz" }]);
    expect(redactSecrets("zzz zzz zzz", extra)).toBe(
      "[REDACTED:x] [REDACTED:x] [REDACTED:x]",
    );
  });

  it("skips a malformed regex without disabling the built-in floor", () => {
    // Unbalanced group → invalid regex; must be skipped, not thrown.
    const extra = compileRedactionPatterns([
      { name: "bad", regex: "([unterminated" },
      { name: "good", regex: "mysecret" },
    ]);
    expect(extra.map((p) => p.name)).toEqual(["good"]);
    const out = redactSecrets("mysecret AKIAIOSFODNN7EXAMPLE", extra);
    expect(out).toContain("[REDACTED:good]");
    expect(out).toContain("[REDACTED:aws-access-key]");
  });

  it("returns [] for empty/absent config", () => {
    expect(compileRedactionPatterns(undefined)).toEqual([]);
    expect(compileRedactionPatterns([])).toEqual([]);
  });
});

describe("isFailoverError / FallbackProvider", () => {
  it("cascades only transient pressure by default (auth/quota/invalid do not)", () => {
    // Transient pressure cascades.
    expect(isFailoverError("429 Too Many Requests")).toBe(true);
    expect(isFailoverError("rate limit exceeded")).toBe(true);
    expect(isFailoverError("ETIMEDOUT")).toBe(true);
    expect(isFailoverError("Anthropic 503: overloaded")).toBe(true);
    // Deterministic / account-scoped errors do NOT cascade by default.
    expect(isFailoverError("quota exhausted")).toBe(false);
    expect(isFailoverError("OpenAI 401: invalid api key")).toBe(false);
    expect(isFailoverError("OpenAI 403: forbidden")).toBe(false);
    expect(isFailoverError("invalid_request_error: bad tool schema")).toBe(false);
    // Quota cascades only when the policy opts in.
    expect(isFailoverError("insufficient_quota", "next")).toBe(true);
    expect(isFailoverError("insufficient_quota", "fail")).toBe(false);
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

  it("does not cascade an auth (401) error to the backup", async () => {
    const p = new FallbackProvider([
      fakeProvider("primary", [{ kind: "error", message: "OpenAI 401: invalid api key" }]),
      fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "SHOULD NOT APPEAR" }, { kind: "done", finishReason: "stop" }]),
    ]);
    const out = await collect(p.stream({ model: "m", messages: [] }));
    expect(out.some((e) => e.kind === "text_delta")).toBe(false);
    expect(out.some((e) => e.kind === "provider_failover")).toBe(false);
    const last = out[out.length - 1]!;
    expect(last.kind).toBe("error");
    expect((last as { message: string }).message).toContain("401");
  });

  it("does not cascade a quota error under the default policy", async () => {
    const p = new FallbackProvider([
      fakeProvider("primary", [{ kind: "error", message: "insufficient_quota: you exceeded your current quota" }]),
      fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "SHOULD NOT APPEAR" }, { kind: "done", finishReason: "stop" }]),
    ]);
    const out = await collect(p.stream({ model: "m", messages: [] }));
    expect(out.some((e) => e.kind === "text_delta")).toBe(false);
  });

  it("cascades a quota error when onQuota is 'next'", async () => {
    const p = new FallbackProvider(
      [
        fakeProvider("primary", [{ kind: "error", message: "insufficient_quota" }]),
        fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "ok from backup" }, { kind: "done", finishReason: "stop" }]),
      ],
      undefined,
      "next",
    );
    const out = await collect(p.stream({ model: "m", messages: [] }));
    expect(out.some((e) => e.kind === "text_delta" && e.text === "ok from backup")).toBe(true);
  });

  it("emits an observational provider_failover event on each switch", async () => {
    const p = new FallbackProvider([
      fakeProvider("primary", [{ kind: "error", message: "Anthropic 503: overloaded" }]),
      fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "ok" }, { kind: "done", finishReason: "stop" }]),
    ]);
    const out = await collect(p.stream({ model: "m", messages: [] }));
    const fo = out.find((e) => e.kind === "provider_failover");
    expect(fo).toBeDefined();
    expect(fo && fo.kind === "provider_failover" && fo.from).toBe("primary");
    expect(fo && fo.kind === "provider_failover" && fo.to).toBe("backup");
    expect(fo && fo.kind === "provider_failover" && fo.failureKind).toBe("server_5xx");
  });

  it("notifies the onFailover observer with the structured kind", async () => {
    const seen: Array<{ from: string; to: string; kind: string }> = [];
    const p = new FallbackProvider(
      [
        fakeProvider("primary", [{ kind: "error", message: "429 rate limited" }]),
        fakeProvider("backup", [{ kind: "text_delta", messageId: "m", text: "ok" }, { kind: "done", finishReason: "stop" }]),
      ],
      (from, to, _reason, kind) => seen.push({ from, to, kind }),
    );
    await collect(p.stream({ model: "m", messages: [] }));
    expect(seen).toEqual([{ from: "primary", to: "backup", kind: "rate_limit" }]);
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

  it("PostToolUse updatedResult REPLACES the result text (redaction)", async () => {
    const h = new HookEngine(
      {
        PostToolUse: [
          { matcher: "*", command: `sh -c 'echo "{\\"updatedResult\\":\\"[redacted]\\"}"'` },
        ],
      },
      dir
    );
    const r = await h.runPostToolUse("bash", {}, "sk-SECRET-TOKEN-12345", false);
    expect(r.updatedResult).toBe("[redacted]");
    // The raw JSON is NOT also pushed as feedback when it carried a rewrite.
    expect(r.feedback).toBeUndefined();
  });

  it("PostToolUse: first updatedResult wins; later hooks see the rewritten text", async () => {
    const h = new HookEngine(
      {
        PostToolUse: [
          // First hook rewrites to "ONE".
          { matcher: "*", command: `sh -c 'echo "{\\"updatedResult\\":\\"ONE\\"}"'` },
          // Second hook echoes back the result payload it was given as feedback,
          // proving it saw "ONE" (the rewrite), not the original output.
          { matcher: "*", command: `sh -c 'cat'` },
        ],
      },
      dir
    );
    const r = await h.runPostToolUse("bash", {}, "ORIGINAL", false);
    expect(r.updatedResult).toBe("ONE");
    // The second hook's stdout (the payload JSON it was fed) contains the
    // rewritten result, not the original.
    expect(r.feedback).toContain("ONE");
    expect(r.feedback).not.toContain("ORIGINAL");
  });

  it("PostToolUse updatedResult composes with feedback (both honoured)", async () => {
    const h = new HookEngine(
      {
        PostToolUse: [
          {
            matcher: "*",
            command: `sh -c 'echo "{\\"updatedResult\\":\\"clean\\",\\"feedback\\":\\"note\\"}"'`,
          },
        ],
      },
      dir
    );
    const r = await h.runPostToolUse("bash", {}, "dirty", false);
    expect(r.updatedResult).toBe("clean");
    expect(r.feedback).toBe("note");
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
    expect(r.content).toContain("Q (q1): scope?\nA: A");
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
    expect(taskTool.description).toContain("isolated contexts");
    expect(taskTool.description).toContain("parallel independent");
  });
});
