/**
 * LAN advertise helpers — phone QR must not use 127.0.0.1.
 */

import { networkInterfaces } from "node:os";

/** IPv4 addresses on non-internal interfaces (prefer private LAN). */
export function listLanIPv4(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const e of entries) {
      if (e.internal || e.family !== "IPv4") continue;
      out.push(e.address);
    }
  }
  // Prefer RFC1918 first
  out.sort((a, b) => score(b) - score(a));
  return out;
}

function score(ip: string): number {
  if (ip.startsWith("192.168.")) return 3;
  if (ip.startsWith("10.")) return 2;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
  return 1;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/**
 * Rewrite a serve URL's host from loopback to a LAN IP so phones can reach it.
 * Leaves non-loopback hosts unchanged. Port/path/query preserved.
 */
export function advertiseUrl(serveUrl: string, lanIp?: string): {
  url: string;
  rewritten: boolean;
  lanIp?: string;
  warning?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(serveUrl);
  } catch {
    return { url: serveUrl, rewritten: false, warning: "Invalid serve URL" };
  }
  // Only http(s) can be reached by a phone. A file:// (desktop SPA origin) or
  // ws:// slipping through here would produce an unusable QR — reject clearly
  // rather than emit it.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      url: serveUrl.replace(/\/+$/, ""),
      rewritten: false,
      warning: `Serve URL must be http(s) for remote pairing (got "${parsed.protocol}//").`,
    };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { url: serveUrl.replace(/\/+$/, ""), rewritten: false };
  }
  const ip = lanIp ?? listLanIPv4()[0];
  if (!ip) {
    return {
      url: serveUrl.replace(/\/+$/, ""),
      rewritten: false,
      warning:
        "No LAN IP found — phone cannot reach 127.0.0.1. Connect to Wi‑Fi or pass --host <lan-ip>.",
    };
  }
  parsed.hostname = ip;
  return {
    url: parsed.toString().replace(/\/+$/, ""),
    rewritten: true,
    lanIp: ip,
    warning:
      "Phone QR uses your LAN IP. Start serve with --host 0.0.0.0 (or the LAN IP) so the phone can connect.",
  };
}
