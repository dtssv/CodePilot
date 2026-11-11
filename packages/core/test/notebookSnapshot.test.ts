// Regression: notebook_edit changed files on disk but the session's
// touched-file set (used by snapshot/rewind) tracked only write_file /
// edit_file / apply_patch. A notebook edited this turn was therefore absent
// from a snapshot, so a rewind could not restore it. notebook_edit is now
// tracked by its `notebook_path`, the same as the other write tools by `path`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session.js";

const tempHome = process.env.HOME ?? tmpdir();

function notebook(source: string): string {
  return JSON.stringify({
    cells: [
      { cell_type: "code", id: "c0", metadata: {}, source: [source], outputs: [], execution_count: null },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

/** call 1 → read_file(notebook); call 2 → notebook_edit(replace cell 0);
 * call 3 → plain "done". */
function fakeModel(nbPath: string): Promise<{ server: Server; url: string }> {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null): string =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const toolCall = (id: string, name: string, args: object): object => ({
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      });
      if (calls === 1) {
        res.end(chunk(toolCall("c_read", "read_file", { path: nbPath }), null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else if (calls === 2) {
        res.end(
          chunk(
            toolCall("c_nb", "notebook_edit", {
              notebook_path: nbPath,
              cell_index: 0,
              edit_mode: "replace",
              new_source: "print('edited')",
            }),
            null,
          ) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        );
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

describe("notebook_edit is tracked for snapshot / rewind", () => {
  let model: Server;
  let url: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tempHome, "nb-snap-"));
    ({ server: model, url } = await fakeModel("nb.ipynb"));
  });
  afterAll(() => {
    model.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("snapshots the notebook and rewind restores its original cell content", async () => {
    const nbPath = join(workDir, "nb.ipynb");
    writeFileSync(nbPath, notebook("print('original')"));

    const session = await createSession({
      cwd: workDir,
      model: "fake",
      config: {
        sandbox: { mode: "off" },
        permissionMode: "yolo",
        providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } },
      } as never,
    });

    // Snapshot BEFORE the edit turn — captures the original on-disk notebook.
    // (touchedFiles persists across turns within a session, but here we take the
    // baseline first, then edit, then rewind back to it.)
    await session.prompt("edit the notebook");
    // The edit landed.
    expect(readFileSync(nbPath, "utf-8")).toContain("print('edited')");

    // The notebook is in the touched set → snapshot includes it.
    const snapId = await session.snapshot("after-edit");
    expect(typeof snapId).toBe("string");

    // Mutate again on disk, then rewind to the post-edit snapshot restores it.
    writeFileSync(nbPath, notebook("print('garbage')"));
    await session.rewind(snapId);
    expect(readFileSync(nbPath, "utf-8")).toContain("print('edited')");
    expect(readFileSync(nbPath, "utf-8")).not.toContain("garbage");
  });
});
