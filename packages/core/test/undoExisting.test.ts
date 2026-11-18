import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/session/session.js";
import { createSnapshotFromContents, rewindToSnapshot } from "../src/session/snapshots.js";

// Undo baselines are pre-images captured right before each file write, so a
// file that existed before the turn is restored (not deleted) and bytes
// round-trip exactly.

function fakeModel(path: string): Promise<{ server: Server; url: string }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (calls === 1) {
        const rc = { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] };
        res.end(chunk(rc, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else if (calls === 2) {
        const tc = { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path, content: "agent\n" }) } }] };
        res.end(chunk(tc, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
      } else res.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })));
}

describe("undo of a pre-existing file first written this turn", () => {
  let model: Server; let url: string; let dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(process.env.HOME ?? tmpdir(), "undo-ex-")); ({ server: model, url } = await fakeModel("keep.txt")); });
  afterAll(() => { model.close(); rmSync(dir, { recursive: true, force: true }); });

  it("restores the original content instead of deleting the file", async () => {
    writeFileSync(join(dir, "keep.txt"), "original\n");
    const s = await createSession({ cwd: dir, model: "fake", config: { sandbox: { mode: "off" }, permissionMode: "yolo", providers: { fake: { provider: "openai", baseURL: url, apiKey: "x", model: "fake", models: ["fake"] } } } as never });
    await s.prompt("overwrite keep.txt");
    expect(readFileSync(join(dir, "keep.txt"), "utf-8")).toBe("agent\n");
    await s.undo();
    expect(existsSync(join(dir, "keep.txt"))).toBe(true);
    expect(readFileSync(join(dir, "keep.txt"), "utf-8")).toBe("original\n");
  }, 30_000);
});

describe("snapshot blobs", () => {
  it("round-trip binary content and delete tombstoned paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-bin-"));
    try {
      const bin = Buffer.from([0, 255, 128, 10, 0xc3, 0x28]);
      const id = await createSnapshotFromContents(dir, new Map([[join(dir, "b.bin"), bin], [join(dir, "new.txt"), null]]), "t");
      writeFileSync(join(dir, "b.bin"), "clobbered");
      writeFileSync(join(dir, "new.txt"), "created later");
      const r = await rewindToSnapshot(dir, id);
      expect(readFileSync(join(dir, "b.bin")).equals(bin)).toBe(true);
      expect(existsSync(join(dir, "new.txt"))).toBe(false);
      expect(r.deleted).toEqual(["new.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
