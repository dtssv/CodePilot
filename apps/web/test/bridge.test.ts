// Host bridge: the IDE relay path. Runs in node with a minimal `window`
// stand-in that behaves like the IntelliJ (JCEF) channel.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Win = {
  __codepilotHostPost?: (json: string) => void;
  __codepilotReceive?: (json: string) => void;
  addEventListener(): void;
  location: { search: string };
};

let win: Win;

beforeEach(() => {
  win = { addEventListener: () => {}, location: { search: "?host=idea" } };
  vi.stubGlobal("window", win);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function load() {
  return import("../src/protocol/bridge.js");
}

describe("HostBridge (IntelliJ channel)", () => {
  it("queues messages until the host injects its channel, then flushes in order", async () => {
    vi.useFakeTimers();
    const { HostBridge } = await load();
    const bridge = new HostBridge("idea");
    bridge.post({ type: "ready" });
    bridge.post({ type: "rpc", line: '{"id":1}' });
    const sent: string[] = [];
    win.__codepilotHostPost = (json) => sent.push(json);
    await vi.advanceTimersByTimeAsync(60);
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(["ready", "rpc"]);
  });

  it("delivers host messages to listeners", async () => {
    const { HostBridge } = await load();
    const bridge = new HostBridge("idea");
    const got: unknown[] = [];
    bridge.on((m) => got.push(m));
    win.__codepilotReceive?.(JSON.stringify({ type: "host/theme", theme: "light" }));
    win.__codepilotReceive?.("not json");
    expect(got).toEqual([{ type: "host/theme", theme: "light" }]);
  });

  it("detects the host from ?host=", async () => {
    const { detectHostKind } = await load();
    expect(detectHostKind()).toBe("idea");
  });
});

describe("BridgeTransport", () => {
  it("relays lines both ways and ends when the engine stops", async () => {
    const { HostBridge, BridgeTransport } = await load();
    const sent: string[] = [];
    win.__codepilotHostPost = (json) => sent.push(json);
    const bridge = new HostBridge("idea");
    const transport = new BridgeTransport(bridge);
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });

    transport.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    expect(JSON.parse(sent[0]!)).toEqual({ type: "rpc", line: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });

    const pending = transport.readLine();
    win.__codepilotReceive?.(JSON.stringify({ type: "rpc", line: '{"id":1,"result":{}}\n{"id":2,"result":{}}' }));
    expect(await pending).toBe('{"id":1,"result":{}}');
    expect(await transport.readLine()).toBe('{"id":2,"result":{}}');

    const eof = transport.readLine();
    win.__codepilotReceive?.(JSON.stringify({ type: "host/engine", state: "stopped" }));
    expect(await eof).toBeNull();
    expect(closed).toBe(true);
    expect(() => transport.write("{}")).toThrow(/engine stopped/);
  });

  it("bridgeOpener waits for the engine to be ready", async () => {
    const { HostBridge, bridgeOpener } = await load();
    const sent: string[] = [];
    win.__codepilotHostPost = (json) => {
      sent.push(json);
      if (JSON.parse(json).type === "ready") {
        queueMicrotask(() => win.__codepilotReceive?.(JSON.stringify({ type: "host/engine", state: "ready" })));
      }
    };
    const opened = await bridgeOpener(new HostBridge("idea"))();
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(["ready"]);
    opened.close();
  });
});
