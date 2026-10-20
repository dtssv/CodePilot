// Audit log: record mapping (event → AuditRecord), redaction-safe input
// summaries, and read/export round-trip.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger, readAuditLog, type AuditRecord } from "../src/audit.js";
import type { Event } from "../src/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cp-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readRecords(): AuditRecord[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files.flatMap((f) =>
    readFileSync(join(dir, f), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRecord),
  );
}

// onEvent writes are fire-and-forget; give the microtask/IO a tick to flush.
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("AuditLogger", () => {
  it("records tool_call with a redaction-safe input summary and correlates the result", async () => {
    const log = new AuditLogger("sess-1", { dir });
    const events: Event[] = [
      { type: "tool_call", id: "t1", name: "bash", input: { command: "ls -la /tmp" } },
      { type: "tool_result", toolCallId: "t1", name: "bash", content: "a\nb\nc", isError: false },
    ];
    for (const e of events) log.onEvent(e);
    await flush();

    const recs = readRecords();
    const call = recs.find((r) => r.type === "tool_call");
    expect(call).toMatchObject({ sessionId: "sess-1", tool: "bash", toolCallId: "t1", input: "ls -la /tmp" });
    const result = recs.find((r) => r.type === "tool_result");
    // tool name is carried over from the matching call id.
    expect(result).toMatchObject({ tool: "bash", toolCallId: "t1", isError: false, resultChars: 5 });
  });

  it("does not record secret-bearing full inputs — only the primary-arg summary", async () => {
    const log = new AuditLogger("sess-2", { dir });
    log.onEvent({
      type: "tool_call",
      id: "t1",
      name: "web_fetch",
      input: { url: "https://api.example.com", authorization: "Bearer SECRET-TOKEN-123" },
    });
    await flush();
    const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8")).join("");
    expect(raw).toContain("https://api.example.com");
    expect(raw).not.toContain("SECRET-TOKEN-123"); // non-primary keys are dropped
  });

  it("records errors and compaction, ignores chat/status events", async () => {
    const log = new AuditLogger("sess-3", { dir });
    const events: Event[] = [
      { type: "message", id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "status", status: "running" },
      { type: "error", message: "boom", recoverable: true },
      { type: "compaction", summary: "earlier" },
    ];
    for (const e of events) log.onEvent(e);
    await flush();
    const recs = readRecords();
    expect(recs.map((r) => r.type).sort()).toEqual(["compaction", "error"]);
    expect(recs.find((r) => r.type === "error")?.message).toBe("boom");
  });

  it("truncates a very long input summary", async () => {
    const log = new AuditLogger("sess-4", { dir });
    log.onEvent({ type: "tool_call", id: "t1", name: "bash", input: { command: "x".repeat(500) } });
    await flush();
    const call = readRecords().find((r) => r.type === "tool_call");
    expect(call?.input?.length).toBeLessThanOrEqual(120);
    expect(call?.input?.endsWith("…")).toBe(true);
  });
});

describe("readAuditLog", () => {
  it("filters by session and honours the limit", async () => {
    const a = new AuditLogger("A", { dir });
    const b = new AuditLogger("B", { dir });
    a.onEvent({ type: "tool_call", id: "1", name: "glob", input: { pattern: "**/*.ts" } });
    b.onEvent({ type: "tool_call", id: "2", name: "grep", input: { pattern: "TODO" } });
    a.onEvent({ type: "tool_call", id: "3", name: "ls", input: { path: "/x" } });
    await flush();

    const all = await readAuditLog({ dir });
    expect(all.length).toBe(3);
    const onlyA = await readAuditLog({ dir, sessionId: "A" });
    expect(onlyA.every((r) => r.sessionId === "A")).toBe(true);
    expect(onlyA.length).toBe(2);
    const limited = await readAuditLog({ dir, limit: 1 });
    expect(limited.length).toBe(1);
  });

  it("returns [] for a missing directory", async () => {
    expect(await readAuditLog({ dir: join(dir, "nope") })).toEqual([]);
  });

  it("tolerates a torn final line", async () => {
    const log = new AuditLogger("T", { dir });
    log.onEvent({ type: "error", message: "ok", recoverable: false });
    await flush();
    const file = join(dir, readdirSync(dir)[0]!);
    const fs = await import("node:fs/promises");
    await fs.appendFile(file, '{"ts":"x","sessionId":"T","type":"err', "utf-8"); // truncated JSON
    const recs = await readAuditLog({ dir });
    expect(recs.length).toBe(1);
    expect(existsSync(file)).toBe(true);
  });
});
