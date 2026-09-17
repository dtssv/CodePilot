// Remembered connection settings.
//
// The token is kept in `sessionStorage`, not `localStorage`: it grants command
// execution on the user's machine, so it should not outlive the tab. The
// server URL and cwd are harmless and persist in `localStorage` so a reload
// does not mean retyping them.

const URL_KEY = "codepilot.url";
const CWD_KEY = "codepilot.cwd";
const TOKEN_KEY = "codepilot.token";

export interface Prefs {
  url: string;
  token: string;
  cwd: string;
}

export function loadPrefs(): Prefs {
  return {
    url: read(localStorage, URL_KEY) ?? defaultUrl(),
    cwd: read(localStorage, CWD_KEY) ?? "",
    token: read(sessionStorage, TOKEN_KEY) ?? "",
  };
}

export function savePrefs(prefs: Prefs): void {
  write(localStorage, URL_KEY, prefs.url);
  write(localStorage, CWD_KEY, prefs.cwd);
  write(sessionStorage, TOKEN_KEY, prefs.token);
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
