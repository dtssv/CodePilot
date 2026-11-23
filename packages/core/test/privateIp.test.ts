import { describe, expect, it } from "vitest";
import { isBlockedDestinationIp, isLiteralIpHost } from "../src/tools/privateIp.js";

describe("isBlockedDestinationIp", () => {
  it("blocks loopback, RFC1918, link-local, CGNAT", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedDestinationIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
      expect(isBlockedDestinationIp(ip), ip).toBe(false);
    }
  });
});

describe("isLiteralIpHost", () => {
  it("detects v4 and v6 literals", () => {
    expect(isLiteralIpHost("127.0.0.1")).toBe(true);
    expect(isLiteralIpHost("[::1]")).toBe(true);
    expect(isLiteralIpHost("::1")).toBe(true);
    expect(isLiteralIpHost("example.com")).toBe(false);
  });
});
