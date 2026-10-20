import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  waitForLiveServeInfo,
  discoverOrSpawnDaemon,
  type Spawner,
} from "../src/engineConnect.js";
import { clearServeInfo, writeServeInfo } from "../src/serve-info.js";

describe("engineConnect / serve discovery", () => {
  const dir = join(homedir(), ".codepilot");

  afterEach(async () => {
    await clearServeInfo();
  });

  it("waitForLiveServeInfo returns null when nothing is advertised", async () => {
    await clearServeInfo();
    const info = await waitForLiveServeInfo(200, 50);
    expect(info).toBeNull();
  });

  it("waitForLiveServeInfo picks up a live lockfile", async () => {
    await writeServeInfo({
      url: "ws://127.0.0.1:18765/rpc",
      token: "t",
      pid: process.pid,
      host: "127.0.0.1",
      port: 18765,
      startedAt: new Date().toISOString(),
    });
    const info = await waitForLiveServeInfo(1000, 20);
    expect(info?.port).toBe(18765);
    expect(info?.token).toBe("t");
  });

  it("discoverOrSpawnDaemon attaches without spawning when live", async () => {
    await writeServeInfo({
      url: "ws://127.0.0.1:18765/rpc",
      token: "abc",
      pid: process.pid,
      host: "127.0.0.1",
      port: 18765,
      startedAt: new Date().toISOString(),
    });
    const spawn = vi.fn() as unknown as Spawner;
    const { info, owned } = await discoverOrSpawnDaemon({
      command: "node",
      args: ["-e", ""],
      spawner: spawn,
    });
    expect(owned).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(info.token).toBe("abc");
  });

  it("discoverOrSpawnDaemon spawns then waits for lockfile", async () => {
    await clearServeInfo();
    class FakeChild extends EventEmitter {
      stderr = new EventEmitter();
      killed = false;
      unref() {}
      kill() {
        this.killed = true;
      }
    }
    const child = new FakeChild();
    const spawner = ((..._args: unknown[]) => {
      // Publish lockfile shortly after "spawn".
      setTimeout(() => {
        void writeServeInfo({
          url: "ws://127.0.0.1:18765/rpc",
          token: "spawned",
          pid: process.pid,
          host: "127.0.0.1",
          port: 18765,
          startedAt: new Date().toISOString(),
        });
      }, 30);
      return child;
    }) as unknown as Spawner;

    const { info, owned } = await discoverOrSpawnDaemon({
      command: "node",
      args: ["serve", "--daemon"],
      waitMs: 2000,
      spawner,
    });
    expect(owned).toBe(child);
    expect(info.token).toBe("spawned");
  });

  it("writeServeInfo also writes server.json alias", async () => {
    mkdirSync(dir, { recursive: true });
    await writeServeInfo({
      url: "ws://127.0.0.1:9/rpc",
      token: "",
      pid: process.pid,
      host: "127.0.0.1",
      port: 9,
      startedAt: new Date().toISOString(),
    });
    const alias = join(dir, "server.json");
    const { readFileSync } = await import("node:fs");
    const body = JSON.parse(readFileSync(alias, "utf-8")) as { port: number };
    expect(body.port).toBe(9);
  });
});
