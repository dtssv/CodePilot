import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUploadNote, materializeUploads, MAX_UPLOAD_BYTES } from "../src/promptFiles.js";

describe("materializeUploads", () => {
  it("writes files under .codepilot/uploads and avoids name clashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-"));
    const a = await materializeUploads(dir, [
      { name: "notes.txt", mediaType: "text/plain", base64: Buffer.from("hello").toString("base64") },
      { name: "notes.txt", mediaType: "text/plain", base64: Buffer.from("again").toString("base64") },
    ]);
    expect(a.map((f) => f.path)).toEqual([
      ".codepilot/uploads/notes.txt",
      ".codepilot/uploads/notes-2.txt",
    ]);
    expect(readFileSync(join(dir, a[0]!.path), "utf8")).toBe("hello");
    expect(readFileSync(join(dir, a[1]!.path), "utf8")).toBe("again");
    expect(formatUploadNote(a)).toContain("notes.txt");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects oversized payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-"));
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1).toString("base64");
    await expect(materializeUploads(dir, [{ name: "big.bin", base64: big }])).rejects.toThrow(/exceeds/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips path segments from the original name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-"));
    const [f] = await materializeUploads(dir, [
      { name: "../../etc/passwd", base64: Buffer.from("x").toString("base64") },
    ]);
    expect(f!.path).toBe(".codepilot/uploads/passwd");
    rmSync(dir, { recursive: true, force: true });
  });
});
