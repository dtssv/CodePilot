//auto-compaction circuit breaker. After enough consecutive
// ineffective compactions (the transcript stays over budget), auto-compaction
// disables itself and surfaces an error instead of looping and burning API
// calls. A manual /compact still runs; a successful one re-enables auto.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionsDir } from "../src/session.js";
import type { Event } from "../src/types.js";

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "cp-breaker-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A summariser SSE that always returns a tiny summary — so even after a
 * "successful" compaction the transcript may stay over a very small budget. */
function stubTinySummary(): void {
  const enc = new TextEncoder();
  vi.stubGlobal("fetch", async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"S"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
}

describe("auto-compaction circuit breaker (K-A4-2)", () => {
  it("disables auto-compaction after repeated ineffective compactions and emits an error", async () => {
    stubTinySummary();
    const id = "breaker-trip";
    // Seed a long history and pin every message so compaction cannot drop the
    // tail below the (tiny) trigger — every auto attempt stays "still full".
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(JSON.stringify({
        type: "message", id: `u${i}`, role: "user", pinned: true,
        content: [{ type: "text", text: `turn ${i} ${"word ".repeat(40)}` }],
      }));
    }
    const dir = getSessionsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n", "utf-8");

    const session = await createSession({
      cwd: workDir,
      sessionId: id,
      config: {
        provider: "openai",
        apiKey: "k",
        baseURL: "https://example.com/v1",
        model: "gpt-4o",
        smallModel: "gpt-4o-mini",
        maxTokens: 256,
        // Tiny window so the pinned history is always over the hard trigger,
        // even after a summary — the definition of thrashing.
        contextWindow: 400,
        compactionThreshold: 0.5,
        autoCompactMaxConsecutiveFailures: 3,
      },
    });

    const errors: Event[] = [];
    session.subscribe((e) => { if (e.type === "error") errors.push(e); });

    const internal = session as unknown as {
      maybeCompact: (o?: { force?: boolean }) => Promise<void>;
      autoCompactDisabled: boolean;
    };

    // Drive several auto-compaction attempts; each should stay over budget.
    for (let n = 0; n < 5; n++) {
      await internal.maybeCompact();
    }

    expect(internal.autoCompactDisabled).toBe(true);
    const tripped = errors.find((e) => e.type === "error" && e.message.includes("Auto-compaction disabled"));
    expect(tripped).toBeTruthy();

    // Once tripped, further auto attempts are a no-op (no new error spam beyond
    // the first trip).
    const errorCountAfterTrip = errors.length;
    await internal.maybeCompact();
    expect(errors.length).toBe(errorCountAfterTrip);
  });
});
