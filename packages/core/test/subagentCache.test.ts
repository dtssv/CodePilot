import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentCache } from "../src/subagentCache.js";

describe("SubagentCache", () => {
  const key = { objective: "analyze module X", agentType: "explore", cwd: "/repo", model: "m1" };

  it("round-trips a successful conclusion (crash-resume replays it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sac-"));
    try {
      const c = new SubagentCache(dir);
      expect(await c.get(key)).toBeNull();
      await c.put(key, { ok: true, conclusion: "done", steps: 3, ts: Date.now() });
      const hit = await c.get(key);
      expect(hit?.conclusion).toBe("done");
      expect(hit?.steps).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never caches failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sac-"));
    try {
      const c = new SubagentCache(dir);
      await c.put(key, { ok: false, conclusion: "boom", steps: 0, ts: Date.now() });
      expect(await c.get(key)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a stale entry older than the TTL (days-later repeat re-runs)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sac-"));
    try {
      const c = new SubagentCache(dir, 1000); // 1s TTL for the test
      await c.put(key, { ok: true, conclusion: "old", steps: 1, ts: Date.now() - 5000 });
      expect(await c.get(key)).toBeNull(); // stale → not replayed
      // A fresh write within TTL is served.
      await c.put(key, { ok: true, conclusion: "fresh", steps: 1, ts: Date.now() });
      expect((await c.get(key))?.conclusion).toBe("fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes entries by objective/type/cwd/model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sac-"));
    try {
      const c = new SubagentCache(dir);
      await c.put(key, { ok: true, conclusion: "A", steps: 1, ts: Date.now() });
      expect(await c.get({ ...key, objective: "different" })).toBeNull();
      expect(await c.get({ ...key, cwd: "/other" })).toBeNull();
      expect((await c.get(key))?.conclusion).toBe("A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
