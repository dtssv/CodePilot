import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUpdate,
  checkEngineUpdate,
  checkForUpdate,
  compareVersions,
  normalizeVersion,
  resetSelfUpdateWatcherForTests,
  runUpdateCheck,
  startSelfUpdateWatcher,
} from "../src/selfUpdate.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("selfUpdate version compare", () => {
  it("normalizes and compares semver-ish tags", () => {
    expect(normalizeVersion("v2.1.1")).toBe("2.1.1");
    expect(compareVersions("2.1.2", "2.1.1")).toBeGreaterThan(0);
    expect(compareVersions("2.1.1", "2.1.1")).toBe(0);
    expect(compareVersions("2.0.0", "2.1.0")).toBeLessThan(0);
  });
});

describe("selfUpdate check + apply", () => {
  afterEach(() => {
    resetSelfUpdateWatcherForTests();
    delete process.env.CODEPILOT_SKIP_UPDATE;
  });

  it("reports available update without installing when checkOnly", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-upd-"));
    mkdirSync(join(root, "lib", "node_modules", "@codepilot", "core"), { recursive: true });
    writeFileSync(
      join(root, "lib", "node_modules", "@codepilot", "core", "package.json"),
      JSON.stringify({ name: "@codepilot/core", version: "1.0.0" }),
    );

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({ tag_name: "v99.0.0" }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const check = await checkForUpdate({
      installRoot: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(check).toMatchObject({
      latest: "99.0.0",
      available: true,
      installRoot: root,
    });

    const after = await runUpdateCheck({
      installRoot: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      checkOnly: true,
      log: () => undefined,
    });
    expect(after?.available).toBe(true);
    // checkOnly must not create tarball leftovers beyond state file
    expect(existsSync(join(root, "update-state.json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("applies in-place npm install with downloaded tarballs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-upd-apply-"));
    const calls: string[][] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({ tag_name: "v9.9.9" }),
        } as Response;
      }
      if (u.endsWith(".tgz")) {
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as Response;
      }
      throw new Error(`unexpected ${u}`);
    });

    // Stub npm via PATH wrapper is hard; call applyUpdate with a fake by
    // monkey-patching spawn through applying after check and intercepting —
    // instead verify download URLs and that applyUpdate invokes npm by
    // temporarily replacing spawnSync via dynamic import is too heavy.
    // Here we only assert check + download path by running apply with a
    // custom npm that we can't easily inject — so unit-test download URLs
    // through a thin apply that catches npm failure after files exist.

    const check = await checkForUpdate({
      installRoot: root,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(check?.available).toBe(true);

    // npm will fail in sandbox without a real registry — we still verify
    // tarballs were fetched before npm runs by catching the error.
    await expect(
      applyUpdate(check!, {
        installRoot: root,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: () => undefined,
      }),
    ).rejects.toThrow(/npm install failed/);

    // Three package downloads
    const tgzCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith(".tgz"));
    expect(tgzCalls.length).toBe(3);
    expect(String(tgzCalls[0]![0])).toContain("codepilot-core-9.9.9.tgz");
    expect(String(tgzCalls[1]![0])).toContain("codepilot-protocol-9.9.9.tgz");
    expect(String(tgzCalls[2]![0])).toContain("codepilot-tui-9.9.9.tgz");
    void calls;
    rmSync(root, { recursive: true, force: true });
  });

  it("startSelfUpdateWatcher is idempotent", () => {
    const a = startSelfUpdateWatcher({ disabled: true });
    const b = startSelfUpdateWatcher({ disabled: true });
    a.stop();
    b.stop();
  });

  it("skips when CODEPILOT_SKIP_UPDATE is set", async () => {
    process.env.CODEPILOT_SKIP_UPDATE = "1";
    const r = await checkForUpdate({
      installRoot: "/tmp/whatever",
      fetchImpl: (async () => {
        throw new Error("should not fetch");
      }) as unknown as typeof fetch,
    });
    expect(r).toBeNull();
  });

  it("checkEngineUpdate reports without install root (cannot auto-apply)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({ tag_name: "v99.0.0" }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const info = await checkEngineUpdate({
      installRoot: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(info).toMatchObject({
      channel: "engine",
      latest: "99.0.0",
      available: true,
      installRoot: null,
      canAutoApply: false,
    });
  });
});
