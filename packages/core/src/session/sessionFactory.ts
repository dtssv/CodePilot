// Session factory + repository: createSession, list/search/export, recovery.
// Loads the concrete Session class lazily to avoid a session.ts cycle.

import { mkdir, mkdir as mkdirIo, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  InterruptedRunInfo,
  SessionOptions,
  SessionSummary,
} from "../types.js";
import { loadConfig } from "../config/config.js";
import { tryLoadRealTokenizer } from "../compaction/tokens.js";
import type { Session } from "./session.js";
import { initPluginRuntimes, mergePluginConfig, pluginResourcePaths } from "../plugins/plugins.js";
import { createLogger } from "../telemetry/logger.js";
import { resolveDefaultModel, resolveModelTarget, applyProviderAndModel } from "../config/providerCatalog.js";
import { openSessionIndex } from "./sessionIndex.js";
import {
  loadCwdFromDisk,
  loadSessionState,
  readSessionSearchCorpus,
  type SessionState,
} from "./sessionIo.js";
import { buildSingleProvider } from "../providers/sessionProviders.js";
import { SESSIONS_DIR, sameCwd, sessionPath, stateSidecarPath } from "./sessionPaths.js";
import { extractTitleAndMeta } from "./sessionTitle.js";

/** Extended session summary with mode, model, and message count. The
 * base `SessionSummary` (in `types.ts`) is kept small for back-compat;
 * `listSessions` and `searchSessions` now return `RichSessionSummary`. */
export interface RichSessionSummary extends SessionSummary {
  mode?: AgentMode;
  model?: string;
  messageCount: number;
  /** Pinned within its workspace (at most one per cwd — see setSessionPinned). */
  pinned?: boolean;
  /** Archived: hidden from the main list, shown under an "Archived" section. */
  archived?: boolean;
  /** Pid of a live process currently holding the single-writer lease, or
   * absent when the session is free. Lets a UI mark a session as being actively
   * written (and whether THIS process is the writer). Enriched on demand. */
  liveWriterPid?: number;
}

export function countMessages(events: ReadonlyArray<Event>): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "message" && (e.role === "user" || e.role === "assistant")) n++;
  }
  return n;
}

async function writeSessionState(id: string, state: SessionState): Promise<void> {
  await mkdirIo(SESSIONS_DIR, { recursive: true });
  const clean: SessionState = {};
  if (state.pinned) clean.pinned = true;
  if (state.archived) clean.archived = true;
  await writeFile(stateSidecarPath(id), JSON.stringify(clean), "utf-8");
}

/** Archive / unarchive a session. Archiving also clears its pin (a hidden
 * session must not stay the workspace's pinned one). */
export async function setSessionArchived(id: string, archived: boolean): Promise<void> {
  const state = await loadSessionState(id);
  state.archived = archived || undefined;
  if (archived) state.pinned = undefined;
  await writeSessionState(id, state);
}

/** Pin / unpin a session. Pin is **one-per-workspace**: pinning a session
 * clears the pin on every other session sharing its cwd, so each workspace has
 * at most one pinned conversation at a time. */
export async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
  const state = await loadSessionState(id);
  if (!pinned) {
    state.pinned = undefined;
    await writeSessionState(id, state);
    return;
  }
  // Enforce one-per-workspace: find this session's cwd, clear other pins there.
  const myCwd = (await loadCwdFromDisk(id)) ?? "(unknown)";
  const all = await listSessionsFullScan();
  await Promise.all(
    all
      .filter((s) => s.id !== id && s.pinned && sameCwd(s.cwd, myCwd))
      .map((s) => setSessionPinned(s.id, false)),
  );
  state.pinned = true;
  state.archived = undefined; // pinning un-archives
  await writeSessionState(id, state);
}

export function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

/**
 * Resolve a "sticky" model from session history: (1) resumed session's last
 * model, (2) newest session in the SAME cwd, (3) newest in ANY cwd. Returns
 * undefined (→ config default) when none. Best-effort — never throws.
 */
async function resolveSessionModel(
  cwd: string,
  sessionId?: string,
): Promise<string | undefined> {
  try {
    // Resume fast path: prefer the SQLite session index (no JSONL parse), then
    // this session's file directly — avoid `listSessions()` which parses every
    // session's JSONL on a cold index (the biggest first-resume stall).
    if (sessionId) {
      try {
        const { openSessionIndex } = await import("./sessionIndex.js");
        const idx = openSessionIndex();
        if (idx) {
          try {
            const hit = idx.list().find((s) => s.id === sessionId);
            if (hit?.model) return hit.model;
          } finally {
            idx.close();
          }
        }
      } catch {
        /* index unavailable — fall through */
      }
      const self = await extractTitleAndMeta(sessionPath(sessionId), sessionId).catch(
        () => undefined,
      );
      if (self?.model) return self.model;
    }
    const all = await listSessions(); // newest-first, every workspace
    const sameCwdHit = all.find((s) => sameCwd(s.cwd, cwd) && s.model);
    if (sameCwdHit?.model) return sameCwdHit.model;
    const anyHit = all.find((s) => s.model);
    return anyHit?.model;
  } catch {
    return undefined;
  }
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const config = { ...(await loadConfig(opts.cwd)), ...(opts.config ?? {}) };
  const id = opts.sessionId ?? generateSessionId();
 // BPE token counting (o200k_base) unless `preciseTokens: false`. Process-wide
 // and best-effort: a load failure leaves the heuristic active. Safe to call
 // repeatedly.
  if (config.preciseTokens !== false) {
    await tryLoadRealTokenizer().catch(() => false);
  }
 // Model priority: explicit opts.model > a model remembered from session
 // history (this session on resume → newest session in the same cwd →
 // newest session anywhere) > config default. This keeps the model "sticky"
 // instead of always snapping back to the first configured one.
  const model = opts.model ?? (await resolveSessionModel(opts.cwd, opts.sessionId)) ?? config.model;

 // Plugin-provided agent runtimes. Registering
 // before the Session is constructed is what makes `runtime: "<plugin>"` in
 // config resolvable — `Session.getRuntime` throws on unknown names.
  let runtime = opts.runtime ?? config.runtime;
  let pluginSkillDirs: string[] | undefined = opts.pluginSkillDirs;
  let pluginAgentDirs: string[] | undefined = opts.pluginAgentDirs;
  let pluginConfig = config;
  if (opts.pluginRuntimes !== false) {
    const log = createLogger("plugins");
    try {
      let trust = opts.pluginTrust;
      if (!trust) {
        const { PluginTrustStore } = await import("../plugins/plugins-trust.js");
        const store = new PluginTrustStore();
        await store.load().catch(() => {});
        trust = store;
      }
      const init = await initPluginRuntimes(opts.cwd, { existingRuntime: runtime, trust });
      runtime = runtime ?? init.defaultRuntime;
      for (const [plugin, message] of init.errors) {
        log.warn(`plugin ${plugin}: runtime module failed to load — ${message}`);
      }
      // Wire a plugin's remaining contributions (hooks + MCP via config merge,
      // skills + agents via discovery dirs). Each step is fault-isolated — a
      // single misconfigured plugin is skipped and never aborts session creation.
      try {
        const merged = mergePluginConfig(
          config as Record<string, unknown>,
          init.plugins,
          (m) => log.warn(m),
          trust,
        ) as typeof config;
        // Keep the authoritative runtime resolved above; take only the
        // hooks/mcpServers the merge contributed (a broken module must not
        // become the default runtime).
        pluginConfig = { ...merged, runtime };
      } catch (err) {
        log.warn(`plugin config merge failed — ${(err as Error).message}`);
      }
      try {
        const paths = pluginResourcePaths(init.plugins);
        if (paths.skills.length > 0) {
          pluginSkillDirs = [...(pluginSkillDirs ?? []), ...paths.skills];
        }
        if (paths.agents.length > 0) {
          pluginAgentDirs = [...(pluginAgentDirs ?? []), ...paths.agents];
        }
      } catch (err) {
        log.warn(`plugin resource paths failed — ${(err as Error).message}`);
      }
    } catch (err) {
 // Conflicting plugin defaults and the like: a misconfigured plugin must
 // not make the session unusable, so fall back to the default loop.
      log.warn(`plugin runtime init failed — ${(err as Error).message}`);
    }
  }

 // Expand the chosen model into a fully-resolved config: a model name alone is
 // not enough — the provider/apiKey/baseURL live in the matching `providers`
 // preset. Without this, buildSingleProvider falls back to Anthropic and fails.
  let resolvedConfig = pluginConfig;
  let resolvedModel = model ?? "";
  const target = model ?? resolveDefaultModel(pluginConfig)?.model;
  if (target) {
    const { providerId } = resolveModelTarget(pluginConfig, target);
    const applied = applyProviderAndModel(pluginConfig, providerId, target);
    resolvedConfig = applied.config;
    resolvedModel = applied.model;
  }
  // Lazy value import of the Session class. Keeping it out of the module's
  // static imports is what breaks the session.ts ⇄ session-utils.ts runtime
  // cycle: this module stays a leaf that session.ts can import freely, and the
  // concrete class is only resolved when a session is actually constructed.
  const { Session } = await import("./session.js");
  const session = new Session(id, {
    ...opts,
    config: resolvedConfig,
    runtime,
    pluginSkillDirs,
    pluginAgentDirs,
 // Empty string forces Session to keep config.model; avoid inventing a
 // vendor id the user never configured (was "claude-sonnet-4-5").
    model: resolvedModel || config.model || "",
  });
  await session.init();
  return session;
}

// SQLite metadata index. Opened lazily and cached per process. The
// daemon and standalone CLI each hold their own handle to the shared index.db;
// cross-process safety comes from WAL + busy_timeout inside sessionIndex.ts.
// `null` means "index unavailable" → callers use the full-scan path below.
let cachedIndex: import("./sessionIndex.js").SessionIndex | null | undefined;
function sessionIndexEnabled(): boolean {
  // Opt-out escape hatch: CODEPILOT_SESSION_INDEX=off forces the full-scan path
  // (useful if a platform can't load the native addon).
  return process.env.CODEPILOT_SESSION_INDEX !== "off";
}
function getSessionIndex(): import("./sessionIndex.js").SessionIndex | null {
  if (cachedIndex !== undefined) return cachedIndex;
  if (!sessionIndexEnabled()) {
    cachedIndex = null;
    return null;
  }
  try {
    // openSessionIndex loads better-sqlite3 behind its own createRequire and
    // returns null on any engine failure, so importing this module is cheap and
    // safe even when the native addon is missing.
    cachedIndex = openSessionIndex(SESSIONS_DIR);
  } catch {
    cachedIndex = null;
  }
  return cachedIndex;
}

/** Test/shutdown hook: drop the cached index handle (closes the DB). */
export function resetSessionIndex(): void {
  try {
    cachedIndex?.close();
  } catch {
    /* ignore */
  }
  cachedIndex = undefined;
}

/**
 * List session summaries (title, model, mode, message count, mtime).
 * Filter by cwd or search via `searchSessions`.
 */
export async function listSessions(
  cwd?: string
): Promise<RichSessionSummary[]> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  // Fast path: SQLite metadata index (reconciles only changed sessions).
  const index = getSessionIndex();
  if (index) {
    try {
      return index.list(cwd);
    } catch {
      // Any index error → fall through to the authoritative full scan.
    }
  }
  return listSessionsFullScan(cwd);
}

async function listSessionsFullScan(
  cwd?: string
): Promise<RichSessionSummary[]> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const summaries: RichSessionSummary[] = [];
  for (const name of entries) {
    // Enumerate live (`.jsonl`) and cold (`.jsonl.br`) sessions alike. A cold
    // session's mtime (on the `.jsonl.br`) is its updatedAt; its content is read
    // transparently by `extractTitleAndMeta`.
    const id = name.endsWith(".jsonl.br")
      ? name.slice(0, -".jsonl.br".length)
      : name.endsWith(".jsonl")
        ? name.slice(0, -".jsonl".length)
        : undefined;
    if (!id) continue;
    const path = join(SESSIONS_DIR, name);
    try {
      const st = await stat(path);
      const derived = await extractTitleAndMeta(sessionPath(id), id);
      const state = await loadSessionState(id);
      summaries.push({
        id,
        title: derived.title,
        updatedAt: st.mtimeMs,
 // Never invent cwd from the filter arg — that made every session
 // appear bound to whichever workspace you asked about.
        cwd: derived.cwd ?? "(unknown)",
        mode: derived.mode,
        model: derived.model,
        messageCount: derived.messageCount,
        pinned: state.pinned,
        archived: state.archived,
      });
    } catch {
 /* skip */
    }
  }
  // Filter by cwd when given (strict — unknown cwd sessions are excluded).
  let filtered = cwd
    ? summaries.filter((s) => sameCwd(s.cwd, cwd))
    : summaries;
  // Drafts: session/new creates a live session before any prompt. Keep it
  // out of the sidebar until the user actually sends a message.
  filtered = filtered.filter((s) => s.messageCount > 0);
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  return filtered;
}

/** A crash-suspended session found by {@link recoverSuspendedSessions}: its id,
 * cwd, and the recovery outcome from sealing it. */
export interface RecoveredSession {
  id: string;
  cwd: string;
  recovery: InterruptedRunInfo;
}

/** Outcome of a boot-time reconcile sweep. Carries the sealed sessions plus
 * telemetry counters so a host can log how many in-flight sessions were found
 * vs. actually sealed. */
export interface ReconcileSummary {
  /** Sessions that were sealed to idle (their load appended a recovery seal). */
  recovered: RecoveredSession[];
  /** Candidates whose last status was in-flight when the sweep started. */
  scanned: number;
  /** Candidates actually sealed this sweep. Equals `recovered.length`. */
  sealed: number;
  /** Candidates skipped — already clean when loaded, or isolated by a
   * per-session error (a live writer's lease, an unreadable file). */
  skipped: number;
}

/** Scan the sessions directory for sessions whose last status is in-flight
 * (running / waiting_permission) — the de-facto crash-suspended marker — when
 * the SQLite index is unavailable. Reads each JSONL fully but only extracts the
 * last status + cwd; bounded by the number of sessions on disk. */
async function suspendedSessionsFullScan(): Promise<
  Array<{ id: string; cwd: string }>
> {
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const out: Array<{ id: string; cwd: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    try {
      const text = await readFile(join(SESSIONS_DIR, name), "utf-8");
      let lastStatus: string | null = null;
      let cwd = "(unknown)";
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Event;
          if (e.type === "status") lastStatus = e.status;
          if (e.cwd) cwd = e.cwd;
        } catch {
          /* skip malformed line */
        }
      }
      if (lastStatus === "running" || lastStatus === "waiting_permission") {
        out.push({ id, cwd });
      }
    } catch {
      /* unreadable → skip */
    }
  }
  return out;
}

/**
 * Boot-time crash-recovery sweep: finds sessions with an in-flight JSONL tail
 * and seals each to a clean idle. Seal-only — never auto-resumes (double-
 * execution risk). Uses the SQLite fast path with a full-scan fallback.
 */
export async function recoverSuspendedSessions(opts?: {
  /** Config applied to each recovered session's load (model resolution, etc.).
   * The recovery itself does not run the agent, so most config is irrelevant. */
  config?: CodepilotConfig;
}): Promise<ReconcileSummary> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  let candidates: Array<{ id: string; cwd: string }>;
  const index = getSessionIndex();
  if (index) {
    try {
      candidates = index.suspended().map((s) => ({ id: s.id, cwd: s.cwd }));
    } catch {
      candidates = await suspendedSessionsFullScan();
    }
  } else {
    candidates = await suspendedSessionsFullScan();
  }

  const recovered: RecoveredSession[] = [];
  let skipped = 0;
  for (const c of candidates) {
    try {
      const session = await createSession({
        cwd: c.cwd && c.cwd !== "(unknown)" ? c.cwd : process.cwd(),
        sessionId: c.id,
        config: opts?.config,
      });
      try {
        const recovery = session.getInterruptedRecovery();
        // The index/scan can lag the on-disk truth (a session may have been
        // cleanly idled since). Only report sessions the load actually sealed.
        if (recovery) {
          recovered.push({ id: c.id, cwd: c.cwd, recovery });
        } else {
          skipped += 1; // already clean when loaded
        }
      } finally {
        await session.dispose();
      }
    } catch {
      // Isolate per-session failure — keep sweeping the rest. A live writer's
      // lease (another process owns recovery) or an unreadable file lands here.
      skipped += 1;
    }
  }
  return {
    recovered,
    scanned: candidates.length,
    sealed: recovered.length,
    skipped,
  };
}

/**
 * Search session summaries by title or content (case-insensitive). Returns
 * matches sorted by recency.
 */
export async function searchSessions(
  query: string,
  opts: { cwd?: string; limit?: number } = {}
): Promise<SessionSummary[]> {
  // Fast path: metadata-only search via the index (title / cwd / first user
  // message). Does not scan full message bodies — a deliberate scope choice
  // When the index is off, the full-corpus fallback below runs.
  const index = getSessionIndex();
  if (index) {
    try {
      return index.search(query, opts);
    } catch {
      /* fall through to full-scan search */
    }
  }
  const all = await listSessionsFullScan(opts.cwd);
  if (!query.trim()) return all;
  const q = query.toLowerCase();
  const matches: Array<{ s: SessionSummary; score: number }> = [];
  for (const s of all) {
    if (s.title.toLowerCase().includes(q)) {
      matches.push({ s, score: 100 });
      continue;
    }
 // Look at the persisted content for richer matching.
    const content = await readSessionSearchCorpus(s.id);
    if (content.toLowerCase().includes(q)) {
      matches.push({ s, score: 1 });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.s.updatedAt - a.s.updatedAt);
  const out = matches.map((m) => m.s);
  return opts.limit ? out.slice(0, opts.limit) : out;
}