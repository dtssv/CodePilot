import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSessionInbox,
  saveSessionInbox,
  clearSessionInbox,
  inboxSidecarPath,
} from "../src/session/session-inbox.js";

describe("session inbox sidecar", () => {
  it("round-trips user steers and follow-ups; drops system steers on load", async () => {
    const prev = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cp-inbox-"));
    process.env.HOME = home;
    try {
      const id = "2026-01-01T00-00-00-000Z_testinbox";
      await saveSessionInbox(id, {
        steering: [
          { source: "user", text: "fix the approach", delivery: "steer" },
          { source: "system", text: "job done", delivery: "steer" },
        ],
        followUps: [
          { id: "fu_1", text: "after this", queuedAt: 1 },
        ],
      });
      expect(existsSync(inboxSidecarPath(id))).toBe(true);
      const loaded = await loadSessionInbox(id);
      expect(loaded.steering).toEqual([
        { source: "user", text: "fix the approach", delivery: "steer" },
      ]);
      expect(loaded.followUps).toEqual([{ id: "fu_1", text: "after this", queuedAt: 1 }]);

      await saveSessionInbox(id, { steering: [], followUps: [] });
      expect(existsSync(inboxSidecarPath(id))).toBe(false);
      await clearSessionInbox(id);
    } finally {
      process.env.HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
