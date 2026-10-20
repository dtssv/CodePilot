import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, deleteSession, getSessionsDir } from "../src/session.js";
import { historyArchivePath } from "../src/session-utils.js";
import { estimateEventTokens, renderTranscriptArchive } from "../src/compaction.js";
import { estimateTokens } from "../src/tokens.js";
import type { Event } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

interface Req {
  system?: string;
  last: string;
}

function fakeModel(requests: Req[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
      const sys = b.messages.find((m) => m.role === "system");
      const last = b.messages.at(-1)!;
      requests.push({
        system: typeof sys?.content === "string" ? sys.content : undefined,
        last: typeof last.content === "string" ? last.content : JSON.stringify(last.content),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(chunk({ role: "assistant", content: "SUMMARY-OR-REPLY" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ server, url: `http://127.0.0.1:${port}/v1` });
    }),
  );
}

describe("compaction keeps the dropped turns reachable", () => {
  const requests: Req[] = [];
  let model: Server;
  let url: string;
  let workDir: string;

  beforeAll(async () => {
    ({ server: model, url } = await fakeModel(requests));
    workDir = mkdtempSync(join(tempHome, "work-"));
  });
  afterAll(() => {
    model.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("archives the dropped turns verbatim and points the summary at them", async () => {
    const id = "compaction-archive-test";
    const design = `DESIGN-START ${"queue with retry and dead-letter, idempotent consumers. ".repeat(70)}DESIGN-END`;
    const events: Event[] = [
      { type: "message", id: "u0", role: "user", content: [{ type: "text", text: "设计一个消息重试方案" }] },
      { type: "message", id: "a0", role: "assistant", content: [{ type: "text", text: design }] },
    ];
    for (let i = 1; i <= 20; i++) {
      const words = (tag: string): string => Array.from({ length: 150 }, (_, k) => `${tag}${i}w${k}`).join(" ");
      events.push({ type: "message", id: `u${i}`, role: "user", content: [{ type: "text", text: `电影推荐 ${words("q")}` }] });
      events.push({ type: "message", id: `a${i}`, role: "assistant", content: [{ type: "text", text: `推荐 ${words("r")}` }] });
    }
    mkdirSync(getSessionsDir(), { recursive: true });
    writeFileSync(join(getSessionsDir(), `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const estimated = estimateEventTokens(events, estimateTokens);
    expect(estimated).toBeGreaterThan(4_500);
    expect(estimated).toBeLessThan(7_500);

    const session = await createSession({
      cwd: workDir,
      sessionId: id,
      model: "fake",
      config: {
        sandbox: { mode: "off" },
        contextWindow: 8_000,
 // Estimated history (4.5K–7.5K tokens) sits between this trigger (4K) and
 // the full window: only the configured threshold makes it compact.
        compactionThreshold: 0.5,
        providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } },
      } as never,
    });
    await session.prompt("按最初的方案实现");

    const persisted = readFileSync(join(getSessionsDir(), `${id}.jsonl`), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Event);
 // Original turns stay in the transcript file.
    expect(persisted.some((e) => e.type === "message" && e.id === "a0")).toBe(true);
    const compactEv = [...persisted].reverse().find((e) => e.type === "compaction");
    expect(compactEv?.type).toBe("compaction");
    const archive = historyArchivePath(id);
    expect(compactEv && compactEv.type === "compaction" && compactEv.summary).toContain(archive);
    const live = session.getEvents();
    expect(live[0]?.type).toBe("compaction");
    expect(live.some((e) => e.type === "message" && e.id === "a0")).toBe(false);

 // getHistory() keeps the ORIGINAL messages for display even though the
 // model-facing getEvents() dropped them. This is the user-visible fix:
 // compaction must not make earlier turns disappear from the UI.
    const history = session.getHistory();
    expect(history.some((e) => e.type === "message" && e.id === "a0")).toBe(true);
    expect(history.some((e) => e.type === "message" && e.id === "u0")).toBe(true);
    expect(history.some((e) => e.type === "compaction")).toBe(true);

 // A fresh subscriber (e.g. a reconnecting UI) replays the full history,
 // not the compacted set, so it sees the original turns too.
    const replayed: Event[] = [];
    const unsub = session.subscribe((e) => replayed.push(e));
    unsub();
    expect(replayed.some((e) => e.type === "message" && e.id === "a0")).toBe(true);

    expect(existsSync(archive)).toBe(true);
    const text = readFileSync(archive, "utf-8");
    expect(text).toContain(design);
    expect(text).toContain("### USER");
    expect(text).toContain("设计一个消息重试方案");

    const summariserCall = requests.find((r) => r.system?.includes("context compactor"));
    expect(summariserCall?.system).toContain("1. USER REQUESTS");
    await session.dispose?.();
    await deleteSession(id);
  }, 30_000);
});

describe("renderTranscriptArchive", () => {
  it("keeps message text whole and caps big tool results with their artifact", () => {
    const big = "z".repeat(25_000);
    const out = renderTranscriptArchive([
      { type: "message", id: "a", role: "assistant", content: [{ type: "text", text: "plan line 1\nplan line 2" }] },
      { type: "tool_call", id: "t1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", toolCallId: "t1", name: "bash", content: big, artifactRef: "art_1" },
      { type: "usage", usage: { input: 1, output: 1 } },
    ]);
    expect(out).toContain("### ASSISTANT\n\nplan line 1\nplan line 2");
    expect(out).toContain('### TOOL CALL bash\n\n{"command":"ls"}');
    expect(out).toContain("### TOOL RESULT bash (artifact art_1)");
    expect(out).toContain("5000 chars trimmed; full text via read_artifact art_1");
    expect(out).not.toContain("usage");
  });
});
