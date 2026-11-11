// Protocol backend for harness_bridge: drives a fake Codex app-server over
// JSONL/stdio and checks the final-answer extraction, plus the opt-in gating
// and CLI fallback at the tool level.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCodexAppServerTurn } from "../src/tools/harnessCodexProto.js";
import { harnessBridgeTool } from "../src/tools/harnessBridge.js";
import { resolveSandbox } from "../src/sandbox.js";
import type { ToolContext } from "../src/tools/types.js";

/** A fake `codex app-server`: a Node script that speaks the JSONL protocol —
 * answers initialize/newConversation/sendUserTurn, streams two agent-message
 * deltas, then completes the turn. */
async function writeFakeAppServer(
  dir: string,
  opts: { mode?: "ok" | "noFinal" | "error" } = {},
): Promise<string[]> {
  const mode = opts.mode ?? "ok";
  const path = join(dir, "fake-appserver.mjs");
  const body = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === 'initialized') {
    // notification, no reply
  } else if (msg.method === 'newConversation') {
    ${mode === "error" ? "send({ id: msg.id, error: { code: -1, message: 'boom' } });" : "send({ id: msg.id, result: { conversationId: 'conv-1' } });"}
  } else if (msg.method === 'sendUserTurn') {
    send({ id: msg.id, result: {} });
    ${
      mode === "noFinal"
        ? "send({ method: 'turn/completed', params: {} });"
        : "send({ method: 'item/agentMessage/delta', params: { delta: 'Hello ' } });\n    send({ method: 'item/agentMessage/delta', params: { delta: 'world' } });\n    send({ method: 'turn/completed', params: {} });"
    }
  }
});
`;
  await writeFile(path, body, "utf-8");
  await chmod(path, 0o755);
  return [process.execPath, path];
}

describe("runCodexAppServerTurn (fake app-server)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codexproto-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drives the handshake + turn and returns the streamed final answer", async () => {
    const command = await writeFakeAppServer(dir);
    const res = await runCodexAppServerTurn("do the thing", {
      command,
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(res.ok).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.finalText).toBe("Hello world");
  });

  it("reports not-ok when the turn produced no final answer", async () => {
    const command = await writeFakeAppServer(dir, { mode: "noFinal" });
    const res = await runCodexAppServerTurn("x", { command, cwd: dir, timeoutMs: 10_000 });
    expect(res.ok).toBe(true); // turn completed cleanly...
    expect(res.finalText).toBe(""); // ...but with no text
  });

  it("reports not-ok on a protocol error", async () => {
    const command = await writeFakeAppServer(dir, { mode: "error" });
    const res = await runCodexAppServerTurn("x", { command, cwd: dir, timeoutMs: 10_000 });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.join(" ")).toMatch(/error|boom/i);
  });

  it("times out a hung app-server", async () => {
    const path = join(dir, "hang.mjs");
    await writeFile(path, "setInterval(() => {}, 1000);\n", "utf-8");
    const res = await runCodexAppServerTurn("x", {
      command: [process.execPath, path],
      cwd: dir,
      timeoutMs: 400,
    });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  }, 10_000);
});

describe("harness_bridge protocol backend gating", () => {
  let dir: string;
  const ctx = (config?: unknown): ToolContext => ({
    cwd: dir,
    artifact: async () => "art_x",
    readArtifact: async () => "",
    sandbox: resolveSandbox({ mode: "off" }, dir ?? "/tmp"),
    config: config as never,
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codexproto-tool-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the protocol backend for codex when enabled in config", async () => {
    const command = await writeFakeAppServer(dir);
    const r = await harnessBridgeTool.execute(
      { harness: "codex", prompt: "hi", backend: "protocol" },
      ctx({ harnessBridge: { allowProtocol: true, codexAppServerCommand: command } }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("Hello world");
  });

  it("falls back to the CLI path when protocol is requested but not allowed", async () => {
    // allowProtocol defaults off → the codex CLI path is taken. With no real
    // `codex` binary present this surfaces a not-found error (proving the CLI
    // path, not the protocol path, ran).
    const r = await harnessBridgeTool.execute(
      { harness: "codex", prompt: "hi", backend: "protocol" },
      ctx({ harnessBridge: { allowProtocol: false } }),
    );
    // CLI path attempted codex exec; absent binary → spawn error, not a crash.
    expect(typeof r.content).toBe("string");
  });

  it("falls back to the CLI when the protocol backend yields no answer", async () => {
    const command = await writeFakeAppServer(dir, { mode: "noFinal" });
    const r = await harnessBridgeTool.execute(
      { harness: "codex", prompt: "hi", backend: "protocol" },
      ctx({ harnessBridge: { allowProtocol: true, codexAppServerCommand: command } }),
    );
    // A fallback note is prepended and the CLI path ran.
    expect(r.content).toMatch(/using CLI/);
  });
});
