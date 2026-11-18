/** Parse "Name: value" lines into a headers map (blank / malformed lines skipped). */
export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

/** Collect unique `${ENV}` names from a search template's url/headers/body. */
export function listTemplateEnvVars(parts: {
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}): string[] {
  const chunks = [parts.url, parts.body, ...Object.values(parts.headers ?? {})];
  const found = new Set<string>();
  for (const chunk of chunks) {
    if (!chunk) continue;
    for (const m of chunk.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

/**
 * The HTTP(S) origin a phone connects to for remote pairing. Web-served: just
 * `window.location` origin. Desktop loads the SPA over `file://` but passes the
 * daemon's real URL in `?ws=` — convert ws(s):// to http(s)://, else the QR
 * payload is an unopenable `file://.../remote/pair?...`.
 */
export function resolveServeUrl(): string {
  const origin = `${window.location.protocol}//${window.location.host}`;
  if (window.location.protocol !== "file:" && window.location.host) {
    return origin;
  }
  const ws = new URLSearchParams(window.location.search).get("ws");
  if (ws) {
    try {
      const u = new URL(ws);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      // Drop the ws path (e.g. "/rpc") — the pairing/static routes live at the
      // origin root. Keeping it made the phone load the SPA under /rpc/remote/,
      // so its relative ./assets/ 404'd and the pair route never matched.
      u.pathname = "/";
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/+$/, "");
    } catch {
      /* fall through */
    }
  }
  return origin;
}