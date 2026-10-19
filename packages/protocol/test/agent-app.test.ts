import { describe, expect, it } from "vitest";

import { agentPageUrl, appWindowArgs, findAppBrowser } from "../src/agent-app.js";

describe("findAppBrowser", () => {
  it("prefers Chrome, then Edge, on macOS", () => {
    const have = new Set(["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]);
    expect(findAppBrowser("darwin", { HOME: "/Users/me" }, (p) => have.has(p))).toEqual({
      name: "Microsoft Edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    });
    have.add("/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(findAppBrowser("darwin", { HOME: "/Users/me" }, (p) => have.has(p))?.name).toBe("Microsoft Edge");
  });

  it("searches PATH on Linux", () => {
    const found = findAppBrowser("linux", { PATH: "/usr/local/bin:/usr/bin" }, (p) => p === "/usr/bin/chromium");
    expect(found).toEqual({ name: "chromium", path: "/usr/bin/chromium" });
  });

  it("returns null when nothing is installed", () => {
    expect(findAppBrowser("linux", { PATH: "/usr/bin" }, () => false)).toBeNull();
  });
});

describe("agentPageUrl", () => {
  it("opens the agent layout with the token and folder", () => {
    const url = new URL(agentPageUrl("127.0.0.1", 4321, "t0k", "/work/my project"));
    expect(url.origin).toBe("http://127.0.0.1:4321");
    expect(Object.fromEntries(url.searchParams)).toEqual({ layout: "agent", cwd: "/work/my project", token: "t0k" });
  });

  it("app window args use a dedicated profile", () => {
    const args = appWindowArgs("http://x/", "/p");
    expect(args).toContain("--app=http://x/");
    expect(args).toContain("--user-data-dir=/p");
  });
});
