// /rewind: go back to before a user prompt — the conversation (model view and
// displayed history) and, by default, the files those turns changed. The log
// stays append-only; a `rewind` event marks the hidden span.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, getSessionsDir } from "../src/session/session.js";
import { liveTranscript, visibleHistory } from "../src/compaction/compaction.js";
import type { Event } from "../src/types.js";

/** Each prompt: one write_file of `f<N>.txt` (N = 1 + prompts already answered), then "done". */
function fakeModel(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;
      const firstText = (c: unknown) =>
        typeof c === "string" ? c : Array.isArray(c) ? ((c[0] as { text?: string })?.text ?? "") : "";
      const isPrompt = (m: { role: string; content: unknown }) =>
        m.role === "user" && ["first", "second", "only"].includes(firstText(m.content));
      const lastPrompt = messages.findLastIndex(isPrompt);
      const lastTool = messages.findLastIndex((m) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (lastPrompt > lastTool) {
        const n = messages.filter(isPrompt).length;
        const tc = {
          role: "assistant",
          tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `f${n}.txt`, content: `${n}\n` }) } }],
        };
        res.end(chunk(tc, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else {
        res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
      }
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })),
  );
}

const userTexts = (events: Event[]) =>
  events.filter((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user")
    .map((e) => e.content.map((b) => (b.type === "text" ? b.text : "")).join(""));

describe("rewindConversation", () => {
  let model: Server;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(process.env.HOME ?? tmpdir(), "rewind-"));
    ({ server: model, url } = await fakeModel());
  });
  afterAll(() => {
    model.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops the turns and reverts their files; survives a reload", async () => {
    const sessionId = `rewind-${Math.random().toString(36).slice(2, 8)}`;
    const config = {
      sandbox: { mode: "off" },
      permissionMode: "yolo",
      providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } },
    } as never;
    const s = await createSession({ cwd: dir, sessionId, model: "fake", config });
    await s.prompt("first");
    await s.prompt("second");
    expect(existsSync(join(dir, "f1.txt")) && existsSync(join(dir, "f2.txt"))).toBe(true);
    expect(s.rewindTargets().map((t) => t.text)).toEqual(["first", "second"]);

    const r = await s.rewindConversation();
    expect(r).toMatchObject({ text: "second", turns: 1, deleted: ["f2.txt"] });
    expect(existsSync(join(dir, "f2.txt"))).toBe(false);
    expect(readFileSync(join(dir, "f1.txt"), "utf-8")).toBe("1\n");
    expect(userTexts(s.getEvents())).toEqual(["first"]);
    expect(userTexts(s.getHistory())).toEqual(["first"]);
    // Nothing deleted from the log.
    const raw = readFileSync(join(getSessionsDir(), `${sessionId}.jsonl`), "utf-8");
    expect(raw).toContain('"second"');
    expect(raw).toContain('"type":"rewind"');

    const reloaded = await createSession({ cwd: dir, sessionId, model: "fake", config });
    expect(userTexts(reloaded.getEvents())).toEqual(["first"]);
    expect(reloaded.rewindTargets().map((t) => t.text)).toEqual(["first"]);

    const first = reloaded.rewindTargets()[0]!.messageId;
    const r2 = await reloaded.rewindConversation(first);
    expect(r2.deleted).toEqual(["f1.txt"]);
    expect(existsSync(join(dir, "f1.txt"))).toBe(false);
    expect(reloaded.getEvents().some((e) => e.type === "message")).toBe(false);
  }, 30_000);

  it("can keep the files and rewind only the conversation", async () => {
    const d = mkdtempSync(join(process.env.HOME ?? tmpdir(), "rewind-keep-"));
    const { server, url: u } = await fakeModel();
    try {
      const s = await createSession({
        cwd: d,
        model: "fake",
        config: { sandbox: { mode: "off" }, permissionMode: "yolo", providers: { fake: { provider: "openai", baseURL: u, apiKey: "x", model: "fake", models: ["fake"] } } } as never,
      });
      await s.prompt("only");
      const r = await s.rewindConversation(undefined, { files: false });
      expect(r.deleted).toEqual([]);
      expect(existsSync(join(d, "f1.txt"))).toBe(true);
      expect(s.undoDepth()).toBe(1);
      expect(userTexts(s.getEvents())).toEqual([]);
    } finally {
      server.close();
      rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("liveTranscript with rewind markers", () => {
  const msg = (id: string, role: "user" | "assistant"): Event => ({ type: "message", id, role, content: [{ type: "text", text: id }] });

  it("voids a compaction inside the rewound span", () => {
    const log: Event[] = [
      msg("u1", "user"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("a2", "assistant"),
      { type: "compaction", summary: "S", keepFrom: 2 },
      msg("u3", "user"),
      { type: "rewind", toMessageId: "u2" },
      msg("u4", "user"),
    ];
    expect(liveTranscript(log).map((e) => (e.type === "message" ? e.id : e.type))).toEqual(["u1", "a1", "u4"]);
    expect(visibleHistory(log).map((e) => (e.type === "message" ? e.id : e.type))).toEqual(["u1", "a1", "u4"]);
  });

  it("keeps a compaction before the rewound span", () => {
    const log: Event[] = [
      msg("u1", "user"),
      { type: "compaction", summary: "S", keepFrom: 1 },
      msg("u2", "user"),
      msg("u3", "user"),
      { type: "rewind", toMessageId: "u3" },
    ];
    expect(liveTranscript(log).map((e) => (e.type === "message" ? e.id : e.type))).toEqual(["compaction", "u2"]);
  });
});
