// Remembered connection settings — in particular WHERE the token is kept.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadPrefs, savePrefs } from "../src/prefs.js";

class FakeStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

let local: FakeStorage;
let session: FakeStorage;

beforeEach(() => {
  local = new FakeStorage();
  session = new FakeStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("window", { location: { hostname: "127.0.0.1", port: "4179" } });
  return () => vi.unstubAllGlobals();
});

describe("prefs", () => {
  it("keeps the token out of localStorage", () => {
    // The token grants command execution on the user's machine, so it must
    // not outlive the tab. Only the harmless fields persist.
    savePrefs({ url: "ws://127.0.0.1:4179/rpc", token: "secret-token", cwd: "/repo" });
    expect(local.keys()).toEqual(["codepilot.url", "codepilot.cwd"]);
    expect(JSON.stringify(local)).not.toContain("secret-token");
    expect(session.getItem("codepilot.token")).toBe("secret-token");
  });

  it("round-trips what it saved", () => {
    savePrefs({ url: "ws://host:1/rpc", token: "t", cwd: "/x" });
    expect(loadPrefs()).toEqual({ url: "ws://host:1/rpc", token: "t", cwd: "/x" });
  });

  it("clears a field that was emptied instead of keeping the old value", () => {
    savePrefs({ url: "ws://host:1/rpc", token: "t", cwd: "/x" });
    savePrefs({ url: "ws://host:1/rpc", token: "", cwd: "" });
    expect(loadPrefs().token).toBe("");
    expect(loadPrefs().cwd).toBe("");
  });

  it("defaults the URL to this page's own host and port", () => {
    // When the server serves this page, the socket is on the same origin.
    expect(loadPrefs().url).toBe("ws://127.0.0.1:4179/rpc");
  });

  it("survives storage that throws (private browsing)", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("localStorage", hostile);
    vi.stubGlobal("sessionStorage", hostile);
    expect(() => savePrefs({ url: "u", token: "t", cwd: "c" })).not.toThrow();
    expect(loadPrefs()).toEqual({ url: "ws://127.0.0.1:4179/rpc", token: "", cwd: "" });
  });
});
