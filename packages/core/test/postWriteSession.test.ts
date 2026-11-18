// A session wires post-write formatting + language-server errors into the
// file-writing tools: a write_file result carries the formatter note and the
// new error, and the `diagnostics` tool falls back to the session's language
// server when no IDE answers.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSession } from "../src/session/session.js";
import type { Event } from "../src/types.js";

const FAKE_LSP = fileURLToPath(new URL("./fixtures/fake-lsp.cjs", import.meta.url));

/** Turn 1: write_file a.ts; turn 2: diagnostics on it; then "done". */
function fakeModel(): Promise<{ server: Server; url: string }> {
  const calls = [
    { name: "write_file", arguments: { path: "a.ts", content: "ok    spaced\nERR here\n" } },
    { name: "diagnostics", arguments: { path: "a.ts" } },
  ];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const messages = (JSON.parse(body) as { messages: { role: string }[] }).messages;
      const done = messages.filter((m) => m.role === "tool").length;
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const call = calls[done];
      if (call) {
        const tc = {
          role: "assistant",
          tool_calls: [{ index: 0, id: `c${done}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
        };
        res.end(chunk(tc, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else {
        res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
      }
    });
  });
  return new Promise((ready) =>
    server.listen(0, "127.0.0.1", () => ready({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })),
  );
}

const toolResults = (events: Event[]): string[] =>
  events.flatMap((e) =>
    e.type === "message" && e.role === "tool"
      ? e.content.map((b) => (b.type === "tool_result" ? String(b.content) : ""))
      : e.type === "tool_result"
        ? [String((e as { content?: unknown }).content ?? "")]
        : [],
  );

describe("session post-write", () => {
  let model: Server;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-postwrite-session-"));
    ({ server: model, url } = await fakeModel());
  });
  afterAll(() => {
    model.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("formats the written file and reports its new language-server error", async () => {
    const config = {
      sandbox: { mode: "off" },
      permissionMode: "yolo",
      providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } },
      lsp: { servers: [{ command: process.execPath, args: [FAKE_LSP, "pull"], languages: ["typescript"] }] },
      formatter: {
        squash: {
          command: [
            process.execPath,
            "-e",
            "const f=process.argv[1];const fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/ +/g,' '))",
            "$FILE",
          ],
          extensions: [".ts"],
        },
      },
    } as never;
    const s = await createSession({ cwd: dir, sessionId: `pw-${Math.random().toString(36).slice(2, 8)}`, model: "fake", config });
    try {
      await s.prompt("write it");
      expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("ok spaced\nERR here\n");
      const results = toolResults(s.getEvents()).join("\n---\n");
      expect(results).toContain("a.ts was reformatted by squash");
      expect(results).toContain("a.ts:2:1 error [fake:7] bad ERR here");
      // The diagnostics tool had no host provider and answered from the session's server.
      expect(results).toContain("a.ts:2:1 error [fake:7] bad ERR here\n---");
    } finally {
      await s.dispose();
    }
  });
});
