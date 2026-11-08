import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { CodepilotSettings } from "../src/config.js";
import { Engine, resolveLaunchCommand, tapServerLine, type Spawner } from "../src/engine.js";

const SETTINGS = {
  serverPath: "codepilot",
  cliPath: "",
  nodePath: "node",
  engineMode: "stdio",
} as CodepilotSettings;

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  unref(): void {}
  kill(): void {
    this.killed = true;
  }
}

function makeEngine(settings: CodepilotSettings = SETTINGS) {
  const procs: FakeProc[] = [];
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const spawner = ((cmd: string, args: string[], opts: { cwd: string }) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const p = new FakeProc();
    procs.push(p);
    return p;
  }) as unknown as Spawner;
  const engine = new Engine(() => settings, () => "/work", undefined, spawner);
  return { engine, procs, calls };
}

describe("resolveLaunchCommand", () => {
  it("prefers node <cliPath> when set", () => {
    expect(resolveLaunchCommand({ ...SETTINGS, cliPath: "/x/cli.js" }, undefined, "stdio")).toEqual({
      cmd: "node",
      args: ["/x/cli.js", "serve"],
    });
    expect(resolveLaunchCommand(SETTINGS, undefined, "stdio")).toEqual({
      cmd: "codepilot",
      args: ["serve"],
    });
  });

  it("uses serve --daemon in shared mode", () => {
    expect(resolveLaunchCommand(SETTINGS, undefined, "shared")).toEqual({
      cmd: "codepilot",
      args: ["serve", "--daemon", "--port", "18765"],
    });
    expect(
      resolveLaunchCommand({ ...SETTINGS, cliPath: "/bundled/cli.cjs" }, undefined, "shared"),
    ).toEqual({
      cmd: "node",
      args: ["/bundled/cli.cjs", "serve", "--daemon", "--port", "18765"],
    });
  });
});

describe("Engine", () => {
  it("spawns serve in the workspace and splits stdout into lines (stdio mode)", async () => {
    const { engine, procs, calls } = makeEngine();
    const lines: string[] = [];
    engine.on("line", (l) => lines.push(l));
    engine.start();
    engine.start();
    expect(calls).toEqual([{ cmd: "codepilot", args: ["serve"], cwd: "/work" }]);
    procs[0].stdout.write('{"a":1}\n{"b"');
    procs[0].stdout.write(":2}\n\n");
    await new Promise((r) => setImmediate(r));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("writes newline-terminated lines to stdin", () => {
    const { engine, procs } = makeEngine();
    expect(() => engine.write("x")).toThrow(/not running/);
    engine.start();
    engine.write('{"id":1}');
    expect(procs[0].stdin.read()?.toString()).toBe('{"id":1}\n');
  });

  it("emits exit once and can be restarted", () => {
    const { engine, procs } = makeEngine();
    const exits: string[] = [];
    engine.on("exit", (d) => exits.push(d));
    engine.start();
    procs[0].emit("exit", 1, null);
    procs[0].emit("exit", 1, null);
    expect(exits).toEqual(["engine exited (code=1)"]);
    expect(engine.running).toBe(false);

    engine.start();
    engine.stop();
    expect(procs[1].killed).toBe(true);
    procs[1].emit("exit", null, "SIGTERM");
    expect(exits).toEqual(["engine exited (code=1)", "engine stopped"]);
  });
});

describe("Engine.request (host-side RPC)", () => {
  it("resolves when a matching vsc-host response arrives", async () => {
    const { engine, procs } = makeEngine();
    engine.start();
    const p = engine.request<{ completion: string }>("completion/inline", { prefix: "a" });
    // Read the request the engine wrote to find the id it generated.
    const written = procs[0].stdin.read()?.toString() ?? "";
    const req = JSON.parse(written.trim()) as { id: string; method: string };
    expect(req.method).toBe("completion/inline");
    expect(req.id).toMatch(/^vsc-host-/);
    // Simulate the daemon's response on the shared line stream.
    engine.emit("line", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { completion: "bc" } }));
    await expect(p).resolves.toEqual({ completion: "bc" });
  });

  it("ignores responses for ids it did not issue (webview traffic)", async () => {
    const { engine, procs } = makeEngine();
    engine.start();
    const p = engine.request("completion/inline", {});
    const req = JSON.parse((procs[0].stdin.read()?.toString() ?? "").trim()) as { id: string };
    // A webview response (numeric id) must not resolve our host request.
    engine.emit("line", JSON.stringify({ jsonrpc: "2.0", id: 7, result: { x: 1 } }));
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    engine.emit("line", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects on a JSON-RPC error", async () => {
    const { engine, procs } = makeEngine();
    engine.start();
    const p = engine.request("completion/inline", {});
    const req = JSON.parse((procs[0].stdin.read()?.toString() ?? "").trim()) as { id: string };
    engine.emit("line", JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { message: "nope" } }));
    await expect(p).rejects.toThrow(/nope/);
  });

  it("rejects pending host requests when the engine exits", async () => {
    const { engine, procs } = makeEngine();
    engine.start();
    const p = engine.request("completion/inline", {});
    procs[0].emit("exit", 1, null);
    await expect(p).rejects.toThrow(/stopped|exited/);
  });

  it("aborts when the signal fires", async () => {
    const { engine } = makeEngine();
    engine.start();
    const ctl = new AbortController();
    const p = engine.request("completion/inline", {}, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});

describe("tapServerLine", () => {
  it("picks out event and usage notifications only", () => {
    const events: unknown[] = [];
    const usage: unknown[] = [];
    const h = { onEvent: (_s: string, e: unknown) => events.push(e), onUsage: (u: unknown) => usage.push(u) };
    tapServerLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { sessionId: "s", event: { type: "status", status: "idle" } },
      }),
      h,
    );
    tapServerLine(
      JSON.stringify({ jsonrpc: "2.0", method: "session/usage", params: { sessionId: "s", usage: { input: 3 } } }),
      h,
    );
    tapServerLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "permission/request", params: {} }), h);
    tapServerLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), h);
    tapServerLine('{"method": broken', h);
    expect(events).toEqual([{ type: "status", status: "idle" }]);
    expect(usage).toEqual([{ input: 3 }]);
  });
});
