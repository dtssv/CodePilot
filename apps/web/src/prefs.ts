// Remembered connection settings.
//
// All three fields persist in `localStorage` so a page refresh does not mean
// retyping them. The token grants command execution on the user's machine,
// so it carries an expiry (default 24h): after that the user must re-enter it.
// This trades a little safety for a lot of convenience — the token never
// leaves the browser on this machine, and the serve process it talks to is
// almost always local.

const URL_KEY = "codepilot.url";
const CWD_KEY = "codepilot.cwd";
const TOKEN_KEY = "codepilot.token";
const TOKEN_EXPIRY_KEY = "codepilot.token.expiry";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface Prefs {
  url: string;
  token: string;
  cwd: string;
}

export function loadPrefs(): Prefs {
  // Drop the token if it has expired.
  let token = read(localStorage, TOKEN_KEY) ?? "";
  const expiryStr = read(localStorage, TOKEN_EXPIRY_KEY);
  if (token && expiryStr) {
    const expiry = Number(expiryStr);
    if (!Number.isFinite(expiry) || Date.now() > expiry) {
      token = "";
      try {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXPIRY_KEY);
      } catch { /* non-fatal */ }
    }
  }
  return {
    url: read(localStorage, URL_KEY) ?? defaultUrl(),
    cwd: read(localStorage, CWD_KEY) ?? "",
    token,
  };
}

export function savePrefs(prefs: Prefs): void {
  write(localStorage, URL_KEY, prefs.url);
  write(localStorage, CWD_KEY, prefs.cwd);
  write(localStorage, TOKEN_KEY, prefs.token);
  if (prefs.token) {
    write(localStorage, TOKEN_EXPIRY_KEY, String(Date.now() + TOKEN_TTL_MS));
  } else {
    try { localStorage.removeItem(TOKEN_EXPIRY_KEY); } catch { /* non-fatal */ }
  }
}

/**
 * When this page is served by the protocol server itself, the socket is on the
 * same host and port — so that is the useful default.
 */
function defaultUrl(): string {
  try {
    const { hostname, port } = window.location;
    const suffix = port ? `:${port}` : "";
    return `ws://${hostname || "127.0.0.1"}${suffix}/rpc`;
  } catch {
    return "ws://127.0.0.1:4179/rpc";
  }
}

function read(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    // Storage can throw in private-mode browsers; defaults are fine.
    return null;
  }
}

function write(store: Storage, key: string, value: string): void {
  try {
    if (value) store.setItem(key, value);
    else store.removeItem(key);
  } catch {
    /* non-fatal */
  }
}
