import { describe, expect, it } from "vitest";
import { advertiseUrl, isLoopbackHost } from "../src/netAdvertise.js";

describe("advertiseUrl", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });

  it("rewrites 127.0.0.1 to a LAN IP when available", () => {
    const r = advertiseUrl("http://127.0.0.1:18765", "192.168.1.10");
    expect(r.rewritten).toBe(true);
    expect(r.url).toBe("http://192.168.1.10:18765");
    expect(r.lanIp).toBe("192.168.1.10");
  });

  it("leaves non-loopback unchanged", () => {
    const r = advertiseUrl("http://192.168.1.5:18765/");
    expect(r.rewritten).toBe(false);
    expect(r.url).toBe("http://192.168.1.5:18765");
  });

  it("rejects a file:// serve URL (desktop SPA origin) with a clear warning", () => {
    // Regression: the desktop app's page origin is file://; it must never
    // become the QR payload. advertiseUrl refuses non-http(s) schemes.
    const r = advertiseUrl("file:///Applications/CodePilot%20Agent.app/index.html");
    expect(r.rewritten).toBe(false);
    expect(r.warning).toMatch(/http\(s\)/i);
  });

  it("rejects a ws:// serve URL too", () => {
    const r = advertiseUrl("ws://127.0.0.1:18765");
    expect(r.rewritten).toBe(false);
    expect(r.warning).toMatch(/http\(s\)/i);
  });
});
