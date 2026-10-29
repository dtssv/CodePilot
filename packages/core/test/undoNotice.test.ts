// Regression: /undo rolled the working tree back to the turn baseline but left
// the transcript untouched, so the model's NEXT turn rebuilt provider messages
// from stale tool_results ("foo.ts was written") against files that no longer
// exist — a file-system ↔ conversation state split. undo()/redo() now append a
// model-visible notice (append-only, no event truncation) so the next turn sees
// the real state.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, getSessionsDir } from "../src/session.js";
import type { Event } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

/** A fake OpenAI-compatible model: the FIRST request streams a `write_file`
 * tool call (creating the file), the SECOND (after the tool_result) streams a
 * plain "done" so the turn finishes. */
function fakeModel(filePath: string): Promise<{ server: Server; url: string }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (calls === 1) {
        // Stream a write_file tool call.
        const toolCall = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_write1",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: filePath, content: "hello from the agent\n" }) },
            },
          ],
        };
        res.end(chunk(toolCall, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else {
        res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
      }
    });
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      done({ server, url: `http://127.0.0.1:${port}/v1` });
    }),
  );
}

describe("undo/redo append a model-visible reconciliation notice", () => {
  let model: Server;
  let url: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tempHome, "undo-"));
    ({ server: model, url } = await fakeModel("note.txt"));
  });
  afterAll(() => {
    model.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("emits <undo_notice> after undo and <redo_notice> after redo", async () => {
    const session = await createSession({
      cwd: workDir,
      model: "fake",
      config: {
        sandbox: { mode: "off" },
        permissionMode: "yolo",
        providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } },
      } as never,
    });

    // One turn that writes a file — this populates the undo stack.
    await session.prompt("create note.txt");
    const target = join(workDir, "note.txt");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("hello from the agent");

    // Undo: file is deleted AND a notice is appended to the transcript.
    const undoResult = await session.undo();
    expect(undoResult.deleted).toContain("note.txt");
    expect(existsSync(target)).toBe(false);

    const afterUndo = session.getEvents();
    const undoNotice = [...afterUndo]
      .reverse()
      .find((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user");
    const undoText =
      undoNotice?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    expect(undoText).toContain("<undo_notice>");
    expect(undoText).toContain("note.txt");
    expect(undoText.toLowerCase()).toContain("stale");

    // The notice is persisted to the JSONL (survives resume), not live-only.
    const persisted = readFileSync(join(getSessionsDir(), `${session.id}.jsonl`), "utf-8");
    expect(persisted).toContain("<undo_notice>");

    // Redo: file comes back AND a symmetric notice is appended.
    const redoResult = await session.redo();
    expect(redoResult.restored.concat(redoResult.deleted)).toContain("note.txt");
    expect(existsSync(target)).toBe(true);

    const afterRedo = session.getEvents();
    const redoNotice = [...afterRedo]
      .reverse()
      .find((e): e is Extract<Event, { type: "message" }> => e.type === "message" && e.role === "user");
    const redoText =
      redoNotice?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    expect(redoText).toContain("<redo_notice>");
    expect(redoText).toContain("note.txt");
  });
});
