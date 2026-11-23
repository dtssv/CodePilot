/**
 * Classify destination IPs for SSRF gates (web_fetch). Blocks loopback,
 * RFC1918, link-local, ULA, and common cloud metadata ranges by default.
 */

/** True when `ip` is a blocked private/local destination. */
export function isBlockedDestinationIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase();
  if (!raw) return true;

  // IPv4-mapped IPv6 (:ffff:a.b.c.d)
  const v4mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4mapped) return isBlockedDestinationIp(v4mapped[1]!);

  if (raw.includes(":")) {
    // IPv6
    if (raw === "::1" || raw === "::") return true;
    // Unique local fc00::/7
    if (raw.startsWith("fc") || raw.startsWith("fd")) return true;
    // Link-local fe80::/10
    if (/^fe[89ab]/.test(raw)) return true;
    return false;
  }

  // IPv4
  const parts = raw.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → refuse
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/** True when hostname is a literal IP (v4 or bracketed/unbracketed v6). */
export function isLiteralIpHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(":")) return true;
  return false;
}
