// Remembered connection settings — in particular WHERE the token is kept.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPrefs,
  savePrefs,
  saveEndpointPref,
  loadEndpointPref,
  matchPreferredEndpoint,
  resolvePreferredEndpoint,
} from "../src/prefs.js";

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
  it("persists the token in localStorage so a new tab can reconnect", () => {
 // Opening the serve-printed link (or refreshing) must not ask for the
 // token again. A restarted serve issues a new token; opening that link
 // overwrites this value.
    savePrefs({
      url: "ws://127.0.0.1:4179/rpc",
      token: "secret-token",
      cwd: "/repo",
      workspaces: ["/repo"],
    });
    expect(local.keys().sort()).toEqual(
      ["codepilot.cwd", "codepilot.token", "codepilot.url", "codepilot.workspaces"].sort(),
    );
    expect(local.getItem("codepilot.token")).toBe("secret-token");
    expect(session.getItem("codepilot.token")).toBeNull();
  });

  it("migrates a leftover sessionStorage token into localStorage", () => {
    session.setItem("codepilot.token", "legacy");
    expect(loadPrefs().token).toBe("legacy");
    expect(local.getItem("codepilot.token")).toBe("legacy");
    expect(session.getItem("codepilot.token")).toBeNull();
  });

  it("round-trips what it saved", () => {
    savePrefs({ url: "ws://host:1/rpc", token: "t", cwd: "/x", workspaces: ["/x"] });
    expect(loadPrefs()).toEqual({
      url: "ws://host:1/rpc",
      token: "t",
      cwd: "/x",
      workspaces: ["/x"],
    });
  });

  it("clears a field that was emptied instead of keeping the old value", () => {
    savePrefs({ url: "ws://host:1/rpc", token: "t", cwd: "/x", workspaces: ["/x"] });
    savePrefs({ url: "ws://host:1/rpc", token: "", cwd: "", workspaces: [] });
    expect(loadPrefs().token).toBe("");
    expect(loadPrefs().cwd).toBe("");
  });

  it("defaults the URL to this page's own host and port", () => {
 // When the server serves this page, the socket is on the same origin.
    expect(loadPrefs().url).toBe("ws://127.0.0.1:4179/rpc");
  });

  it("remembers the selected model across cwd slash variants", () => {
    saveEndpointPref("/repo/", {
      providerId: "ali",
      model: "deepseek-v4.1-flash",
    });
    expect(loadEndpointPref("/repo")).toEqual({
      providerId: "ali",
      model: "deepseek-v4.1-flash",
    });
    const selectable = [
      { providerId: "custom-openai", model: "radfree/DeepSeek-V4.1-Flash" },
      { providerId: "ali", model: "deepseek-v4.1-flash" },
    ];
    expect(matchPreferredEndpoint("/repo", selectable)).toEqual({
      providerId: "ali",
      model: "deepseek-v4.1-flash",
    });
 // Must not fall through to the first selectable model.
    expect(resolvePreferredEndpoint("/repo", selectable)?.model).toBe(
      "deepseek-v4.1-flash",
    );
  });

  it("matches last-endpoint when providerId was a placeholder", () => {
    saveEndpointPref(undefined, {
      providerId: "_active",
      model: "deepseek-v4.1-flash",
    });
    const selectable = [
      { providerId: "custom-openai", model: "radfree/DeepSeek-V4.1-Flash" },
      { providerId: "ali", model: "deepseek-v4.1-flash" },
    ];
    expect(matchPreferredEndpoint("/other", selectable)).toEqual({
      providerId: "ali",
      model: "deepseek-v4.1-flash",
    });
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
    expect(() =>
      savePrefs({ url: "u", token: "t", cwd: "c", workspaces: [] }),
    ).not.toThrow();
    expect(loadPrefs()).toEqual({
      url: "ws://127.0.0.1:4179/rpc",
      token: "",
      cwd: "",
      workspaces: [],
    });
  });
});
