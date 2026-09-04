import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "../src/session.js";
import type { Event } from "../src/types.js";

const tempHome = process.env.HOME ?? tmpdir();

describe("Session — AgentMode (collaboration modes)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tempHome, "mode-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("defaults to 'agent' mode", async () => {
    const s = await createSession({ cwd: workDir });
    expect(s.getAgentMode()).toBe("agent");
    await s.dispose();
  });

  it("honours the SessionOptions.agentMode override", async () => {
    const s = await createSession({ cwd: workDir, agentMode: "plan" });
    expect(s.getAgentMode()).toBe("plan");
    await s.dispose();
  });

  it("honours CodepilotConfig.agentMode when no override is given", async () => {
    const s = await createSession({
      cwd: workDir,
      config: { agentMode: "chat" },
    });
    expect(s.getAgentMode()).toBe("chat");
    await s.dispose();
  });

  it("SessionOptions.agentMode wins over CodepilotConfig.agentMode", async () => {
    const s = await createSession({
      cwd: workDir,
      config: { agentMode: "chat" },
      agentMode: "plan",
    });
    expect(s.getAgentMode()).toBe("plan");
    await s.dispose();
  });

  it("setAgentMode updates getAgentMode, persists a 'mode' event, and notifies subscribers", async () => {
    const s = await createSession({ cwd: workDir, agentMode: "agent" });

    const seen: Event[] = [];
    const unsub = s.subscribe((e) => {
      // Skip the replay — only care about events emitted after subscribe.
      if (!seen.some((x) => x === e)) seen.push(e);
    });

    await s.setAgentMode("chat");
    expect(s.getAgentMode()).toBe("chat");
    const modeEvents = seen.filter((e) => e.type === "mode") as Array<{
      type: "mode";
      mode: string;
    }>;
    expect(modeEvents.length).toBe(1);
    expect(modeEvents[0]!.mode).toBe("chat");

    // The persisted event log also contains the mode event.
    const allModeEvents = s
      .getEvents()
      .filter((e) => e.type === "mode") as Array<{ type: "mode"; mode: string }>;
    expect(allModeEvents.some((e) => e.mode === "chat")).toBe(true);

    unsub();
    await s.dispose();
  });

  it("setAgentMode to the current mode is a no-op (no event emitted)", async () => {
    const s = await createSession({ cwd: workDir, agentMode: "plan" });
    const events: Event[] = [];
    s.subscribe((e) => {
      if (e.type === "mode") events.push(e);
    });
    await s.setAgentMode("plan");
    expect(events.length).toBe(0);
    await s.dispose();
  });

  it("setAgentMode switches back and forth, emitting one event per change", async () => {
    const s = await createSession({ cwd: workDir });
    const events: Event[] = [];
    s.subscribe((e) => {
      if (e.type === "mode") events.push(e);
    });
    await s.setAgentMode("chat");
    await s.setAgentMode("plan");
    await s.setAgentMode("agent");
    await s.setAgentMode("chat");
    expect(events.map((e) => (e as { mode: string }).mode)).toEqual([
      "chat",
      "plan",
      "agent",
      "chat",
    ]);
    await s.dispose();
  });

  it("replay of events includes the mode event for subscribers", async () => {
    const s = await createSession({ cwd: workDir });
    await s.setAgentMode("plan");
    await s.setAgentMode("chat");

    const replayed: Event[] = [];
    s.subscribe((e) => replayed.push(e));
    const modeEvents = replayed.filter((e) => e.type === "mode") as Array<{
      type: "mode";
      mode: string;
    }>;
    expect(modeEvents.map((e) => e.mode)).toEqual(["plan", "chat"]);
    await s.dispose();
  });

  it("forked session inherits the parent's mode", async () => {
    const s = await createSession({ cwd: workDir, agentMode: "chat" });
    const forked = await s.fork();
    expect(forked.getAgentMode()).toBe("chat");
    await forked.dispose();
    await s.dispose();
  });
});