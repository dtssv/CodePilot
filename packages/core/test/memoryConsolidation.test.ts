// Tests for the two-phase background memory pipeline: Phase 1 per-session
// extraction (structured notes, no-op gate, secret redaction, append-only
// drafts) and Phase 2 project-wide consolidation (dual gate, topic reconcile,
// index rebuild, draft cleanup). The small model is faked so the tests are
// deterministic and offline.

import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { autoMemoryDir } from "../src/autoMemory.js";
import {
  extractSessionMemory,
  type MemoryPipelineDeps,
  maybeConsolidateMemory,
} from "../src/memoryConsolidation.js";
import type { ChatProvider, StreamEvent } from "../src/providers/types.js";
import type { Event } from "../src/types.js";

/** A ChatProvider that replies with a fixed string, ignoring the prompt. */
function fakeProvider(reply: string): ChatProvider {
  return {
    name: "fake",
    defaultModel: "m",
    smallModel: "s",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { kind: "text_delta", messageId: "m", text: reply };
      yield { kind: "done", finishReason: "stop" };
    },
  };
}

/** A ChatProvider whose reply depends on the system prompt, so one instance can
 * serve both the extraction and consolidation calls. */
function routingProvider(route: (system: string, user: string) => string): ChatProvider {
  return {
    name: "fake",
    defaultModel: "m",
    smallModel: "s",
    async *stream(req): AsyncIterable<StreamEvent> {
      const system = req.systemPrompt ?? "";
      const user = req.messages
        .flatMap((msg) =>
          msg.content.map((c) => (c.type === "text" ? c.text : "")),
        )
        .join("\n");
      yield { kind: "text_delta", messageId: "m", text: route(system, user) };
      yield { kind: "done", finishReason: "stop" };
    },
  };
}

function msg(role: "user" | "assistant", text: string): Event {
  return { type: "message", id: `${role}-${text.slice(0, 6)}`, role, content: [{ type: "text", text }] };
}

function toolResult(name: string, content: string): Event {
  return { type: "tool_result", toolCallId: "t1", name, content };
}

/** Pad a transcript past the MIN_TRANSCRIPT_CHARS floor. */
const FILLER = "The user and assistant discussed the project at length. ".repeat(10);

describe("memory consolidation — Phase 1 extraction", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "memcon-"));
  });

  it("writes structured drafts and advances the schedule", async () => {
    const reply = JSON.stringify([
      { topic: "architecture", category: "project", summary: "Uses JSONL event sourcing", body: "Append-only per-session files." },
    ]);
    const deps: MemoryPipelineDeps = {
      cwd,
      provider: fakeProvider(reply),
      config: { enabled: true },
    };
    const events = [msg("user", `${FILLER} how is persistence done?`), msg("assistant", "Append-only JSONL.")];
    const n = await extractSessionMemory(events, deps);
    expect(n).toBe(1);

    const dir = autoMemoryDir(cwd);
    const drafts = (await readdir(join(dir, "drafts"))).filter((f) => f.endsWith(".json"));
    expect(drafts.length).toBe(1);
    const note = JSON.parse(await readFile(join(dir, "drafts", drafts[0]!), "utf-8"));
    expect(note.topic).toBe("architecture");
    expect(note.summary).toContain("JSONL");

    const schedule = JSON.parse(await readFile(join(dir, ".consolidation.json"), "utf-8"));
    expect(schedule.draftsSinceLastRun).toBe(1);
  });

  it("no-op gate: an empty array writes nothing", async () => {
    const deps: MemoryPipelineDeps = {
      cwd,
      provider: fakeProvider("[]"),
      config: { enabled: true },
    };
    const events = [msg("user", `${FILLER} trivial chat`), msg("assistant", "ok")];
    const n = await extractSessionMemory(events, deps);
    expect(n).toBe(0);
    await expect(readdir(join(autoMemoryDir(cwd), "drafts"))).rejects.toThrow();
  });

  it("skips a too-short transcript without calling the model", async () => {
    let called = false;
    const provider: ChatProvider = {
      name: "fake",
      defaultModel: "m",
      smallModel: "s",
      async *stream(): AsyncIterable<StreamEvent> {
        called = true;
        yield { kind: "done", finishReason: "stop" };
      },
    };
    const n = await extractSessionMemory([msg("user", "hi")], { cwd, provider, config: { enabled: true } });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it("redacts secrets in extracted notes before they hit disk", async () => {
    const reply = JSON.stringify([
      { topic: "knowledge", category: "project", summary: "token is ghp_abcdefghijklmnopqrstuvwxyz1234", body: "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv here" },
    ]);
    const deps: MemoryPipelineDeps = { cwd, provider: fakeProvider(reply), config: { enabled: true } };
    const events = [msg("user", `${FILLER} secrets`), msg("assistant", "done")];
    await extractSessionMemory(events, deps);
    const dir = autoMemoryDir(cwd);
    const drafts = await readdir(join(dir, "drafts"));
    const note = JSON.parse(await readFile(join(dir, "drafts", drafts[0]!), "utf-8"));
    expect(note.summary).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
    expect(note.summary).toContain("[REDACTED");
    expect(note.body).not.toContain("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
  });

  it("redacts secrets in the transcript fed to the model", async () => {
    let seen = "";
    const provider: ChatProvider = {
      name: "fake",
      defaultModel: "m",
      smallModel: "s",
      async *stream(req): AsyncIterable<StreamEvent> {
        seen = req.messages.flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : ""))).join("");
        yield { kind: "text_delta", messageId: "m", text: "[]" };
        yield { kind: "done", finishReason: "stop" };
      },
    };
    const events = [
      msg("user", `${FILLER} here is my key`),
      toolResult("read_file", "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234"),
    ];
    await extractSessionMemory(events, { cwd, provider, config: { enabled: true } });
    expect(seen).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
    expect(seen).toContain("[REDACTED");
  });

  it("does nothing when auto memory is disabled", async () => {
    const deps: MemoryPipelineDeps = {
      cwd,
      provider: fakeProvider(JSON.stringify([{ topic: "x", category: "project", summary: "s", body: "b" }])),
      config: { enabled: false },
    };
    const n = await extractSessionMemory([msg("user", FILLER)], deps);
    expect(n).toBe(0);
  });
});

describe("memory consolidation — Phase 2 dual gate", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "memcon-"));
  });

  async function seedDrafts(deps: MemoryPipelineDeps, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const reply = JSON.stringify([
        { topic: "architecture", category: "project", summary: `fact number ${i}`, body: `detail ${i}` },
      ]);
      await extractSessionMemory([msg("user", `${FILLER} seed ${i}`), msg("assistant", `ack ${i}`)], {
        ...deps,
        provider: fakeProvider(reply),
      });
    }
  }

  it("does not consolidate before both gates are satisfied", async () => {
    const deps: MemoryPipelineDeps = { cwd, provider: fakeProvider("[]"), config: { enabled: true } };
    await seedDrafts(deps, 2); // below the default min of 5
    const ran = await maybeConsolidateMemory(deps);
    expect(ran).toBe(false);
    // Drafts are untouched.
    const drafts = await readdir(join(autoMemoryDir(cwd), "drafts"));
    expect(drafts.length).toBe(2);
  });

  it("force-consolidates: reconciles drafts into a topic file, rebuilds the index, clears drafts", async () => {
    const consolidated = "- [project] Uses append-only JSONL event sourcing\nOne file per session.";
    const provider = routingProvider((system) =>
      system.includes("reconcile") ? consolidated : "[]",
    );
    const deps: MemoryPipelineDeps = { cwd, provider, config: { enabled: true } };
    await seedDrafts({ ...deps }, 3);

    const ran = await maybeConsolidateMemory(deps, { force: true });
    expect(ran).toBe(true);

    const dir = autoMemoryDir(cwd);
    const topic = await readFile(join(dir, "architecture.md"), "utf-8");
    expect(topic).toContain("append-only JSONL");

    const index = await readFile(join(dir, "MEMORY.md"), "utf-8");
    expect(index).toContain("append-only JSONL");
    expect(index).toContain("architecture.md");

    // Drafts consumed, schedule reset.
    const drafts = await readdir(join(dir, "drafts"));
    expect(drafts.length).toBe(0);
    const schedule = JSON.parse(await readFile(join(dir, ".consolidation.json"), "utf-8"));
    expect(schedule.draftsSinceLastRun).toBe(0);
    expect(schedule.lastConsolidatedAt).toBeGreaterThan(0);
  });

  it("respects a custom draft threshold", async () => {
    const consolidated = "- [project] reconciled line\nbody";
    const provider = routingProvider((system) => (system.includes("reconcile") ? consolidated : "[]"));
    const deps: MemoryPipelineDeps = {
      cwd,
      provider,
      config: { enabled: true, minHoursBetweenConsolidation: 0, minDraftsForConsolidation: 3 },
    };
    await seedDrafts({ ...deps, provider: fakeProvider("[]") }, 3);
    // Reseed with real drafts (previous call used no-op provider).
    await seedDrafts({ ...deps }, 3);
    const ran = await maybeConsolidateMemory(deps);
    expect(ran).toBe(true);
  });

  it("de-duplicates identical drafts by content hash", async () => {
    const reply = JSON.stringify([
      { topic: "architecture", category: "project", summary: "same fact", body: "same body" },
    ]);
    const deps: MemoryPipelineDeps = { cwd, provider: fakeProvider(reply), config: { enabled: true } };
    await extractSessionMemory([msg("user", `${FILLER} a`), msg("assistant", "x")], deps);
    await extractSessionMemory([msg("user", `${FILLER} b`), msg("assistant", "y")], deps);
    const drafts = await readdir(join(autoMemoryDir(cwd), "drafts"));
    expect(drafts.filter((f) => f.endsWith(".json")).length).toBe(1);
  });
});
