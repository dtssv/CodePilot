// Remembered connection settings and open workspaces.
//
// URL, token and workspaces live in `localStorage` so a refresh or a newly
// opened tab (including one opened from the serve-printed link) reconnects
// without the connect form. A restarted `serve` issues a new token; the old
// one simply fails auth until the user opens the new link, which overwrites
// the saved token.

const URL_KEY = "codepilot.url";
const CWD_KEY = "codepilot.cwd";
const WORKSPACES_KEY = "codepilot.workspaces";
const TOKEN_KEY = "codepilot.token";
const ENDPOINTS_KEY = "codepilot.workspaceEndpoints";
const LAST_ENDPOINT_KEY = "codepilot.lastEndpoint";

export interface Prefs {
  url: string;
  token: string;
 /** Last active workspace cwd (may be empty until the user opens a folder). */
  cwd: string;
 /** Open workspaces the user has added in this browser. */
  workspaces: string[];
}

/** Preferred model for a workspace (or the last used globally). */
export interface EndpointPref {
  providerId: string;
  model: string;
}

export function loadPrefs(): Prefs {
  const cwd = read(localStorage, CWD_KEY) ?? "";
  const workspaces = loadWorkspaces();
  // Ensure the remembered cwd is in the open list — append, never reorder.
  if (cwd && !workspaces.some((w) => sameCwd(w, cwd))) workspaces.push(cwd);
  return {
    url: read(localStorage, URL_KEY) ?? defaultUrl(),
    cwd,
    workspaces,
    token: readToken(),
  };
}

export function savePrefs(prefs: Prefs): void {
  write(localStorage, URL_KEY, prefs.url);
  write(localStorage, CWD_KEY, prefs.cwd);
  write(localStorage, TOKEN_KEY, prefs.token);
 // Drop the old sessionStorage copy so we don't keep two sources of truth.
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
 /* ignore */
  }
  saveWorkspaces(prefs.workspaces);
}

/** localStorage first; fall back to a leftover sessionStorage value once. */
function readToken(): string {
  const fromLocal = read(localStorage, TOKEN_KEY);
  if (fromLocal) return fromLocal;
  const fromSession = read(sessionStorage, TOKEN_KEY);
  if (fromSession) {
    write(localStorage, TOKEN_KEY, fromSession);
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
 /* ignore */
    }
    return fromSession;
  }
  return "";
}

export function addWorkspace(cwd: string): string[] {
  const trimmed = cwd.trim().replace(/\/+$/, "") || cwd.trim();
  if (!trimmed) return loadWorkspaces();
  const current = loadWorkspaces();
  // Keep existing order when focusing a workspace; only append truly new ones.
  const existing = current.find((w) => sameCwd(w, trimmed));
  const next = existing
    ? current
    : [...current, trimmed];
  saveWorkspaces(next);
  write(localStorage, CWD_KEY, existing ?? trimmed);
  return next;
}

export function removeWorkspace(cwd: string): string[] {
  const next = loadWorkspaces().filter((w) => w !== cwd);
  saveWorkspaces(next);
  const active = read(localStorage, CWD_KEY);
  if (active === cwd) write(localStorage, CWD_KEY, next[0] ?? "");
  return next;
}

/** Remember the model chosen for a workspace (and as the global last pick). */
export function saveEndpointPref(cwd: string | undefined, pref: EndpointPref): void {
  if (!pref.model) return;
  const normalized: EndpointPref = {
    model: pref.model,
    providerId: pref.providerId || "_active",
  };
  if (cwd) {
    const key = normalizeCwd(cwd);
    const map = loadEndpointMap();
 // Drop stale keys that refer to the same workspace under a different spelling.
    for (const k of Object.keys(map)) {
      if (k !== key && sameCwd(k, key)) delete map[k];
    }
    map[key] = normalized;
    try {
      localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(map));
    } catch {
 /* ignore */
    }
  }
  try {
    localStorage.setItem(LAST_ENDPOINT_KEY, JSON.stringify(normalized));
  } catch {
 /* ignore */
  }
}

export function loadEndpointPref(cwd: string | undefined): EndpointPref | undefined {
  if (cwd) {
    const forCwd = findEndpointForCwd(cwd);
    if (forCwd?.model) return forCwd;
  }
  return loadLastEndpoint();
}

function matchPrefAgainstSelectable(
  pref: EndpointPref | undefined,
  selectable: Array<{ providerId: string; model: string }>,
): EndpointPref | undefined {
  if (!pref?.model || selectable.length === 0) return undefined;
 // Exact provider+model, or tolerate placeholder / stale providerId.
  const hit = selectable.find(
    (m) =>
      m.model === pref.model &&
      (m.providerId === pref.providerId ||
        pref.providerId === "_active" ||
        !pref.providerId),
  );
  if (hit) return { providerId: hit.providerId, model: hit.model };
  const byModel = selectable.find((m) => m.model === pref.model);
  if (byModel) return { providerId: byModel.providerId, model: byModel.model };
  return undefined;
}

/**
 * Match a remembered preference against the selectable list (no fallback).
 * Priority: this cwd → last used globally.
 */
export function matchPreferredEndpoint(
  cwd: string | undefined,
  selectable: Array<{ providerId: string; model: string }>,
): EndpointPref | undefined {
  return (
    matchPrefAgainstSelectable(cwd ? findEndpointForCwd(cwd) : undefined, selectable) ??
    matchPrefAgainstSelectable(loadLastEndpoint(), selectable)
  );
}

/**
 * Resolve which model to use when opening a workspace / session.
 * Priority: this cwd → last used globally → first selectable.
 */
export function resolvePreferredEndpoint(
  cwd: string | undefined,
  selectable: Array<{ providerId: string; model: string }>,
): EndpointPref | undefined {
  if (selectable.length === 0) return undefined;
  return (
    matchPreferredEndpoint(cwd, selectable) ?? {
      providerId: selectable[0]!.providerId,
      model: selectable[0]!.model,
    }
  );
}

/** Look up a saved endpoint allowing trailing-slash / spelling variants. */
function findEndpointForCwd(cwd: string): EndpointPref | undefined {
  const map = loadEndpointMap();
  const key = normalizeCwd(cwd);
  if (map[key]?.model) return map[key];
  for (const [k, v] of Object.entries(map)) {
    if (v?.model && sameCwd(k, key)) return v;
  }
  return undefined;
}

/** Normalize cwd for session↔workspace matching. */
export function normalizeCwd(cwd: string): string {
  const t = cwd.trim();
  if (!t || t === "/") return t || "/";
  return t.replace(/\/+$/, "");
}

export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a === "(unknown)" || b === "(unknown)") return false;
  return normalizeCwd(a) === normalizeCwd(b);
}

function loadEndpointMap(): Record<string, EndpointPref> {
  try {
    const raw = localStorage.getItem(ENDPOINTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, EndpointPref> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as EndpointPref).model === "string"
      ) {
        const providerId =
          typeof (v as EndpointPref).providerId === "string"
            ? (v as EndpointPref).providerId
            : "_active";
 // Store under normalized keys so later lookups are stable.
        out[normalizeCwd(k) || k] = {
          model: (v as EndpointPref).model,
          providerId,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadLastEndpoint(): EndpointPref | undefined {
  try {
    const raw = localStorage.getItem(LAST_ENDPOINT_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as EndpointPref;
    if (v && typeof v.model === "string" && typeof v.providerId === "string") return v;
    return undefined;
  } catch {
    return undefined;
  }
}

function loadWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

function saveWorkspaces(workspaces: string[]): void {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
  } catch {
 /* non-fatal */
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
    return "ws://127.0.0.1:18765/rpc";
  }
}

function read(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
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
