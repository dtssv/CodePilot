import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, listSessions, getSessionsDir } from "../src/session.js";
import type { Event } from "../src/types.js";

// HOME is redirected in test/setup.ts before this module is loaded, so
// SESSIONS_DIR inside session.ts resolves under the temp dir at import time.
const tempHome = process.env.HOME ?? tmpdir();

describe("Session", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "work-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("advertises an installed skill and registers the skill tool", async () => {
    // Regression: the skill tool was implemented+exported but never registered,
    // and skills were never advertised in the prompt — so an installed skill
    // did nothing. Create a project skill and assert both are wired.
    const skillDir = join(workDir, ".codepilot", "skills", "commit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: commit\ndescription: write a good commit message\n---\n\nRun git diff, then write a concise message.\n",
      "utf-8",
    );
    const session = await createSession({ cwd: workDir });
    const prompt = session.getSystemPrompt()?.full ?? "";
    // Advertised in the prompt...
    expect(prompt).toContain("<skills>");
    expect(prompt).toContain("`commit`");
    expect(prompt).toContain("write a good commit message");
    // ...and the `skill` tool is exposed to the model.
    expect(prompt).toMatch(/`skill`/);
  });

  it("persists events as JSONL", async () => {
    const session = await createSession({ cwd: workDir });
    const seen: Event[] = [];
    const unsub = session.subscribe((e) => seen.push(e));
    unsub();
    const id = session.id;
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }) + "\n",
      "utf-8"
    );
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("hello");
  });

  it("replays events on subscribe", async () => {
    const id = "replay-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "hello" }] }),
      ].join("\n") + "\n",
      "utf-8"
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const seen: Event[] = [];
    session.subscribe((e) => seen.push(e));
    expect(seen.length).toBe(2);
    expect((seen[0] as { content: { text: string }[] }).content[0]?.text).toBe("hi");
  });

  it("reuses a turn-boundary pre-compaction instead of summarising again", async () => {
    // A stubbed OpenAI small-model endpoint counts how many times the
    // summariser is called. The session pre-compacts at the turn boundary,
    // then the hard-trigger compaction must REUSE that result (fingerprint
    // match) rather than calling the small model a second time.
    const { vi } = await import("vitest");
    let summariserCalls = 0;
    const enc = new TextEncoder();
    const sse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"SUMMARY"}}]}\n\n'));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    vi.stubGlobal("fetch", async () => {
      summariserCalls++;
      return sse();
    });

    const id = "precompact-reuse";
    // Seed a long history with VARIED text (repeated chars compress away under
    // the token estimator) so it lands in the soft band of the derived window.
    const words = "the quick brown fox jumps over lazy dog alpha beta gamma delta epsilon zeta function return const value error retry commit branch diff patch index token window budget".split(" ");
    const para = (seed: number, n: number): string =>
      Array.from({ length: n }, (_, i) => words[(seed * 7 + i * 13) % words.length]).join(" ");
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(JSON.stringify({ type: "message", id: `u${i}`, role: "user", content: [{ type: "text", text: para(i, 120) }] }));
      lines.push(JSON.stringify({ type: "message", id: `a${i}`, role: "assistant", content: [{ type: "text", text: para(i + 100, 120) }] }));
    }
    writeFileSync(join(getSessionsDir(), `${id}.jsonl`), lines.join("\n") + "\n", "utf-8");

    // Size the window so the seeded history lands in the soft band
    // (0.85·hardTrigger ≤ tokens < hardTrigger). Derive it from the actual
    // estimate so the test isn't brittle to estimator tweaks. With
    // maxTokens=1024, hardTrigger = window − 1024 for a small window, so
    // picking hardTrigger = histTokens/0.92 puts history at ~92% of the band.
    const { estimateEventTokens } = await import("../src/compaction.js");
    const { estimateTokens } = await import("../src/tokens.js");
    const probe = await createSession({ cwd: workDir, sessionId: id, config: { provider: "openai", apiKey: "k", baseURL: "https://example.com/v1", model: "gpt-4o" } });
    const histTokens = estimateEventTokens(probe.getHistory(), estimateTokens);
    const hardTrigger = Math.ceil(histTokens / 0.92);
    const window = hardTrigger + 1024;

    const session = await createSession({
      cwd: workDir,
      sessionId: id,
      config: {
        provider: "openai",
        apiKey: "k",
        baseURL: "https://example.com/v1",
        model: "gpt-4o",
        smallModel: "gpt-4o-mini",
        maxTokens: 1024, // small output reserve → predictable hard trigger
        contextWindow: window,
        compactionThreshold: 0.92,
      },
    });

    const internal = session as unknown as {
      precomputeCompaction: () => Promise<void>;
      maybeCompact: (o?: { force?: boolean }) => Promise<void>;
      precompact: unknown;
    };
    await internal.precomputeCompaction();
    expect(internal.precompact).not.toBeNull(); // a result was cached
    const afterPrecompute = summariserCalls;
    expect(afterPrecompute).toBeGreaterThanOrEqual(1);

    // The hard-trigger compaction must reuse the cached summary (no 2nd call).
    await internal.maybeCompact({ force: true });
    expect(summariserCalls).toBe(afterPrecompute); // reused, not re-summarised
    expect(internal.precompact).toBeNull(); // cache consumed

    vi.restoreAllMocks();
  });

  it("rehydrates offloaded image refs from the artifact store on resume", async () => {
    const { ArtifactStore } = await import("../src/tools/artifacts.js");
    const { projectStatePath } = await import("../src/projectState.js");
    const id = "img-rehydrate";
    // Seed a large base64 as a content-addressed artifact (as persistEvent would).
    const base64 = "QUJD".repeat(4000); // ~16 KB, over the 8 KB offload threshold
    const store = new ArtifactStore(projectStatePath(workDir, "artifacts"));
    await store.init();
    const ref = await store.write(base64, "image/png");
    // Write a JSONL line with the image stored as a {mediaType, ref}, not base64.
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: "message",
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "see image" }],
        images: [{ mediaType: "png", ref }],
      }) + "\n",
      "utf-8",
    );
    // The on-disk line must NOT contain the base64 (it was offloaded).
    expect(readFileSync(path, "utf-8")).not.toContain(base64);

    const session = await createSession({ cwd: workDir, sessionId: id });
    const msg = session
      .getHistory()
      .find((e) => e.type === "message" && (e as { images?: unknown[] }).images) as
      | { images: Array<{ mediaType: string; base64?: string }> }
      | undefined;
    expect(msg).toBeTruthy();
    // After resume the base64 is rehydrated from the artifact.
    expect(msg!.images[0]!.base64).toBe(base64);
  });

  it("prefers a model remembered from same-cwd session history over the config default", async () => {
 // A prior session in this cwd recorded model "glm-5.3" on its assistant turn.
    const priorId = "prior-model-sess";
    const priorPath = join(getSessionsDir(), `${priorId}.jsonl`);
    writeFileSync(
      priorPath,
      [
        JSON.stringify({ type: "message", id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "message", id: "a1", role: "assistant", model: "glm-5.3", content: [{ type: "text", text: "ok" }] }),
      ].join("\n") + "\n",
      "utf-8"
    );
    writeFileSync(join(getSessionsDir(), `${priorId}.cwd`), workDir, "utf-8");

 // A fresh session in the same cwd, with a different config default, should
 // still pick up the sticky model from history.
    const session = await createSession({
      cwd: workDir,
      config: { model: "some-default-model" },
    });
    expect(session.getModel()).toBe("glm-5.3");
  });

  it("reconciles a stale 'running' status to idle on resume", async () => {
    const id = "stale-running";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "go" }] }),
        JSON.stringify({ type: "status", status: "running" }),
      ].join("\n") + "\n",
      "utf-8"
    );
 // Resuming a session whose last status is "running" (interrupted by a
 // restart) must append an idle status so the UI stops showing it as busy.
    const session = await createSession({ cwd: workDir, sessionId: id });
    const text = readFileSync(path, "utf-8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[lines.length - 1]).toMatchObject({ type: "status", status: "idle" });
 // And the reconciling event replays to a fresh subscriber.
    const seen: Event[] = [];
    session.subscribe((e) => seen.push(e));
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ type: "status", status: "idle" });
  });

  it("surfaces interrupt-recovery guidance in the system prompt after an interrupted resume", async () => {
    const id = "interrupted-with-ckpt";
    writeFileSync(
      join(getSessionsDir(), `${id}.jsonl`),
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "do the thing" }] }),
        JSON.stringify({ type: "status", status: "running" }), // cut off mid-run
      ].join("\n") + "\n",
      "utf-8",
    );
 // A checkpoint must exist for the recovery note (it points the model at it).
    mkdirSync(join(workDir, ".codepilot", "checkpoints"), { recursive: true });
    writeFileSync(
      join(workDir, ".codepilot", "checkpoints", `${id}.md`),
      "# Checkpoint\n\n## Task\nDo the thing.\n\n## Done\n- step 1\n",
      "utf-8",
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const prompt = session.getSystemPrompt();
    expect(prompt?.full).toContain("<interrupted_run>");
    expect(prompt?.full).toMatch(/do NOT repeat completed work/i);
  });

  it("does NOT add interrupt-recovery guidance to a cleanly-finished session", async () => {
    const id = "clean-finish";
    writeFileSync(
      join(getSessionsDir(), `${id}.jsonl`),
      [
        JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }),
        JSON.stringify({ type: "status", status: "idle" }), // finished cleanly
      ].join("\n") + "\n",
      "utf-8",
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    expect(session.getSystemPrompt()?.full ?? "").not.toContain("<interrupted_run>");
  });

  it("cancel() with no active run notifies idle so the stop button always works", async () => {
    const session = await createSession({ cwd: workDir });
    const seen: Event[] = [];
    session.subscribe((e) => seen.push(e));
    seen.length = 0; // ignore any replay
    session.cancel(); // no prompt in flight
    const idle = seen.find((e) => e.type === "status" && e.status === "idle");
    expect(idle).toBeTruthy();
  });

  it("sandbox requests permission for a user-named dir outside the jail (ask mode)", async () => {
    // A path outside every default writable root (cwd / tmp / ~/.codepilot).
    // It need not exist — the jail check and the grant are path-based.
    const outside = `/opt/cp-named-${Math.random().toString(36).slice(2, 8)}`;
    const requests: Array<{ sandboxExpand?: { path: string } }> = [];
    const session = await createSession({
      cwd: workDir,
      config: { sandbox: { mode: "workspace-write" }, permissionMode: "ask" },
      onPermissionRequest: async (req) => {
        requests.push(req);
        return "allow";
      },
    });
    await (session as unknown as {
      grantSandboxForMentionedRoots(dirs: string[]): Promise<void>;
    }).grantSandboxForMentionedRoots([outside]);
    // The SANDBOX asked (not the LLM), and the request carried sandboxExpand.
    expect(requests.length).toBe(1);
    expect(requests[0]!.sandboxExpand?.path).toContain(outside);
    // On allow, the dir is now writable in the jail — not silently blocked.
    expect(session.getSandbox().writablePaths.some((p) => p.includes(outside))).toBe(true);
  });

  it("sandbox grants a user-named dir silently in yolo mode (no prompt)", async () => {
    const outside = `/opt/cp-yolo-${Math.random().toString(36).slice(2, 8)}`;
    let asked = 0;
    const session = await createSession({
      cwd: workDir,
      config: { sandbox: { mode: "workspace-write" }, permissionMode: "yolo" },
      onPermissionRequest: async () => {
        asked++;
        return "allow";
      },
    });
    await (session as unknown as {
      grantSandboxForMentionedRoots(dirs: string[]): Promise<void>;
    }).grantSandboxForMentionedRoots([outside]);
    expect(asked).toBe(0); // yolo never prompts
    expect(session.getSandbox().writablePaths.some((p) => p.includes(outside))).toBe(true);
  });

  it("fork creates an independent session with shared prefix", async () => {
    const id = "fork-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "m1", role: "user", content: [{ type: "text", text: "first" }] }) +
        "\n" +
        JSON.stringify({ type: "message", id: "m2", role: "assistant", content: [{ type: "text", text: "ans" }] }) +
        "\n",
      "utf-8"
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const forked = await session.fork(1);
    expect(forked.id).not.toBe(session.id);
    expect(forked.getEvents().length).toBe(1);
    expect(session.getEvents().length).toBe(2);
    await forked.dispose();
    await session.dispose();
  });

  it("fork copies the live view by default and the full log with { fullHistory: true }", async () => {
    // A compacted session: `this.events` (live view) starts at the summary and
    // omits the pre-compaction turns, while `this.persisted` keeps them all.
    // Default fork mirrors the parent's live context; fullHistory recovers the
    // complete trajectory. (Regression: a review claimed fork "corrupts event
    // metadata"; the real, intentional behavior is this live-vs-full choice.)
    const id = "fork-full-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    const lines = [
      { type: "message", id: "u1", role: "user", content: [{ type: "text", text: "old question" }] },
      { type: "message", id: "a1", role: "assistant", content: [{ type: "text", text: "old answer" }] },
      // Summary compaction whose kept tail begins at index 3 (the post-summary
      // user turn). liveTranscript => [compaction, slice(3,3)=∅, slice(4)].
      { type: "compaction", summary: "…earlier turns…", kind: "summary", keepFrom: 4 },
      { type: "message", id: "u2", role: "user", content: [{ type: "text", text: "new question" }] },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");

    const session = await createSession({ cwd: workDir, sessionId: id });
    // Live view drops the two pre-compaction turns (only summary + new turn).
    const liveTexts = (session.getEvents() as Event[])
      .filter((e) => e.type === "message")
      .map((e) => (e as { content: { text: string }[] }).content[0]?.text);
    expect(liveTexts).toEqual(["new question"]);

    const defaultFork = await session.fork();
    const defaultTexts = (defaultFork.getEvents() as Event[])
      .filter((e) => e.type === "message")
      .map((e) => (e as { content: { text: string }[] }).content[0]?.text);
    expect(defaultTexts).toEqual(["new question"]); // mirrors parent's live view

    const fullFork = await session.fork(undefined, { fullHistory: true });
    const fullTexts = (fullFork.getEvents() as Event[])
      .filter((e) => e.type === "message")
      .map((e) => (e as { content: { text: string }[] }).content[0]?.text);
    expect(fullTexts).toEqual(["old question", "old answer", "new question"]);

    await defaultFork.dispose();
    await fullFork.dispose();
    await session.dispose();
  });

  it("getEvents returns the transcript", async () => {
    const id = "ge-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "x", role: "user", content: [{ type: "text", text: "abc" }] }) + "\n",
      "utf-8"
    );
    const session = await createSession({ cwd: workDir, sessionId: id });
    const events = session.getEvents();
    expect(events.length).toBe(1);
    expect((events[0] as { content: { text: string }[] }).content[0]?.text).toBe("abc");
  });

  it("listSessions returns summaries with cwd filter", async () => {
    const id = "list-test";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "message", id: "x", role: "user", content: [{ type: "text", text: "hello world" }] }) + "\n",
      "utf-8"
    );
    writeFileSync(join(getSessionsDir(), `${id}.cwd`), workDir, "utf-8");
    const summaries = await listSessions();
    const found = summaries.find((s) => s.id === id);
    expect(found).toBeDefined();
    expect(found?.title).toContain("hello world");
    expect(found?.cwd).toBe(workDir);
    const filtered = await listSessions(workDir);
    expect(filtered.some((s) => s.id === id)).toBe(true);
    const other = await listSessions("/tmp/other-workspace-that-does-not-match");
    expect(other.some((s) => s.id === id)).toBe(false);
  });

  it("listSessions hides sessions with no messages yet", async () => {
    const id = "list-empty-draft";
    const path = join(getSessionsDir(), `${id}.jsonl`);
    writeFileSync(path, "", "utf-8");
    writeFileSync(join(getSessionsDir(), `${id}.cwd`), workDir, "utf-8");
    const summaries = await listSessions(workDir);
    expect(summaries.some((s) => s.id === id)).toBe(false);
  });
});


describe("Session tool wiring", () => {
  it("gives each session its own task / plan_done / memory_write wiring", async () => {
    const { taskTool } = await import("../src/tools/task.js");
    const before = taskTool.runner;
    const dirA = mkdtempSync(join(tempHome, "work-a-"));
    const dirB = mkdtempSync(join(tempHome, "work-b-"));
    try {
      const a = await createSession({ cwd: dirA });
      const b = await createSession({ cwd: dirB });
      type Reg = { toolRegistry: { get(n: string): Record<string, unknown> | undefined } };
      const tool = (s: unknown, name: string) => (s as Reg).toolRegistry.get(name)!;
      for (const name of ["task", "plan_done", "memory_write"]) {
        expect(tool(a, name)).not.toBe(tool(b, name));
      }
      expect(tool(a, "task").runner).toBeDefined();
      expect(tool(a, "task").runner).not.toBe(tool(b, "task").runner);
 // Creating sessions must not rewire the shared module object.
      expect(taskTool.runner).toBe(before);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
