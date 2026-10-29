// Session factory + repository + provider construction.
//
// Despite the "-utils" filename (kept to avoid churning every import site),
// this module is NOT a grab-bag of helpers: it is the three collaborators the
// `Session` class delegates to —
//   1. ProviderFactory  — buildProvider / buildSmallProvider / FallbackProvider,
//   2. SessionRepository — persistence paths, listing, search, export, delete,
//                          pin/archive, the SQLite metadata index,
//   3. SessionFactory   — `createSession`, which resolves config/model/runtime
//                          then constructs a `Session`.
// Plus a few small pure helpers (titling, id generation) used across the codebase.
//
// It is a *leaf* of the module graph: it imports the `Session` TYPE only, and
// pulls the concrete class in lazily inside `createSession`, so session.ts can
// import these helpers without the old session.ts ⇄ session-utils.ts cycle.

import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  SessionOptions,
  SessionSummary,
} from "./types.js";
import { loadConfig } from "./config.js";
import { tryLoadRealTokenizer } from "./tokens.js";
import { AnthropicProvider, OpenAIProvider, CopilotProvider, GeminiProvider } from "./providers/index.js";
import { FallbackProvider } from "./providers/fallback.js";
import type { ChatProvider } from "./providers/types.js";
// Type-only import: erased at runtime, so it does NOT create a module cycle
// with session.ts (which imports this module's factory/repository helpers).
// The concrete class is pulled in lazily inside `createSession` below.
import type { Session } from "./session.js";
import { initPluginRuntimes } from "./plugins.js";
import { createLogger } from "./logger.js";
import { resolveDefaultModel, resolveModelTarget, applyProviderAndModel } from "./providerCatalog.js";
import { stripThinking } from "./stripThinking.js";
import { openSessionIndex } from "./sessionIndex.js";

export const SESSIONS_DIR = join(homedir(), ".codepilot", "sessions");

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
}

/** Per-session UI state persisted in a `<id>.state` sidecar (JSON). Separate
 * from the JSONL event log so toggling pin/archive is a cheap single-file
 * write and the SQLite index (which folds sidecar mtimes) picks it up. */
export interface SessionState {
  pinned?: boolean;
  archived?: boolean;
}

/** Resolved at call time — useful for tests that change HOME. */
export function getSessionsDir(): string {
  return join(homedir(), ".codepilot", "sessions");
}

/** Format for `exportSession`. */
export type SessionExportFormat = "markdown" | "jsonl";

/** Strip any XML/HTML-ish tags (and stray half-tags). Small models fed a
 * prompt that contains tool-call markup sometimes echo fragments like
 * `</arg_value>` or `<function_calls>` straight into the title. */
function stripTags(s: string): string {
  return s
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>/gi, " ") // well-formed tags
    .replace(/<\/?[a-z][\w-]*/gi, " ") // unterminated opening half-tags
    .replace(/[a-z][\w-]*>/gi, " "); // unterminated closing half-tags
}

export function sanitizeTitle(raw: string): string | null {
  if (!raw) return null;
 // Small models (e.g. MiniMax) often stream chain-of-thought as
 // `<think>…</think>` text_delta. That must never become the sidebar title.
  let t = stripThinking(raw);
 // Reject before stripping: a title that is *mostly* tags/markup is model
 // noise (tool-call echo), not a real title.
  if (/<\/?(?:think|thinking|redacted_reasoning)\b/i.test(t) || /^<think\b/i.test(t)) {
    return null;
  }
  t = stripTags(t);
  t = t.replace(/^["'`]+|["'`]+$/g, "").trim();
 // Strip leading numbering like "1. " or "- ".
  t = t.replace(/^[\-\d.\)\s]+/, "");
 // Collapse whitespace.
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
 // Reject leftover meta-reasoning (English or Chinese) and echoed input that
 // is really a filesystem path, not a title.
  if (
    /^(we need|let me|i need|i'?ll|i will|the user|title only|according to|here is|here'?s|sure|okay|ok\b)/i.test(t) ||
    /^(用户|我需要|我来|我们需要|我会|根据|让我|首先|好的|标题[:：])/.test(t) ||
    /^(?:\/|~\/|[A-Za-z]:[\\/]|Users\/|home\/|\.{1,2}\/)/.test(t)
  ) {
    return null;
  }
 // Hard cap at 60 chars; the small model is asked for 10 but the fallback
 // may be longer. Truncate at a word boundary when possible.
  if (t.length > 60) {
    t = t.slice(0, 60);
    const lastSpace = t.lastIndexOf(" ");
    if (lastSpace > 30) t = t.slice(0, lastSpace);
    t = t.trimEnd() + "…";
  }
  return t;
}

export function deriveTitleFromText(text: string): string {
 // Drop tool-call markup and tags before deriving a fallback, so the
 // deterministic path can't leak `</arg_value>`-style fragments either.
  const clean = stripTags(text).replace(/\s+/g, " ").trim();
  if (!clean) return "(untitled)";
 // Prefer the first sentence.
  const firstSentence = clean.split(/[.?!。？！\n]/)[0] ?? clean;
  return firstSentence.slice(0, 60);
}

/** Does the first user message look like a pasted handoff / tool-call dump
 * rather than a natural request? Such inputs make small models echo markup
 * (e.g. `</arg_value>`), so we skip the model and use a deterministic title. */
function looksLikeMarkupDump(text: string): boolean {
  return (
    /<\/?(?:function_calls|invoke|parameter|arg_value|tool_call|antml:)/i.test(text) ||
    (text.match(/<\/?[a-z][\w-]*[^>]*>/gi)?.length ?? 0) >= 4
  );
}

export async function callTitleModel(
  provider: ChatProvider,
  userText: string,
  model: string | undefined
): Promise<string | null> {
 // For markup-heavy / pasted-dump inputs, don't risk the model echoing
 // tool-call tags — use the deterministic first-sentence title instead.
  if (looksLikeMarkupDump(userText)) return null;
  const sys =
    `You generate a short, neutral session title (≤10 Chinese chars or ≤60 ASCII chars). ` +
    `Output ONLY the title itself — no XML or HTML tags, no quotes, no punctuation, ` +
    `no preamble, no explanation, and do not repeat or quote the user's input.`;
 // Strip any tool-call markup from the input so it can't prime the model to
 // echo tags back; cap length to keep the request cheap.
  const prompt = stripTags(userText).replace(/\s+/g, " ").trim().slice(0, 2000);
  const collected: string[] = [];
  for await (const ev of provider.stream({
    model: model ?? provider.smallModel,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    systemPrompt: sys,
    maxTokens: 64,
  })) {
    if (ev.kind === "text_delta") collected.push(ev.text);
    if (ev.kind === "error") return null;
  }
  const joined = stripThinking(collected.join("")).trim();
  return joined || null;
}

export function countMessages(events: ReadonlyArray<Event>): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "message" && (e.role === "user" || e.role === "assistant")) n++;
  }
  return n;
}

export function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

export function buildProvider(config: CodepilotConfig) {
  const primary = buildSingleProvider(config);
  const chain = [primary];
  for (const fb of config.fallbacks ?? []) {
    chain.push(buildSingleProvider({ ...config, ...fb }));
  }
  if (chain.length === 1) return primary;
  return new FallbackProvider(chain, (from, to, reason) => {
    process.stderr.write(`[provider] failover ${from} → ${to}: ${reason}\n`);
  });
}

export function buildSingleProvider(config: CodepilotConfig): ChatProvider {
  const provider = config.provider ?? "anthropic";
  switch (provider) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseRetryDelayMs,
        maxDelayMs: config.maxRetryDelayMs,
        abortOnDelayMs: config.retryAbortOnDelayMs,
      });
    case "azure":
      // Azure OpenAI speaks the same wire protocol as OpenAI; it differs only
      // in URL shape (deployment + api-version) and auth header. Reuse the
      // OpenAI provider in "azure" dialect.
      return new OpenAIProvider({
        apiStyle: "azure",
        azureApiVersion: config.azureApiVersion,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseRetryDelayMs,
        maxDelayMs: config.maxRetryDelayMs,
        abortOnDelayMs: config.retryAbortOnDelayMs,
      });
    case "copilot":
      return new CopilotProvider({
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
      });
    case "anthropic":
    default:
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: config.model,
        smallModel: config.smallModel ?? config.model,
      });
  }
}

export function buildSmallProvider(config: CodepilotConfig) {
  return buildSingleProvider(config);
}

export async function extractTitleAndMeta(
  path: string,
  id: string
): Promise<{
  title: string;
  cwd?: string;
  mode?: AgentMode;
  model?: string;
  messageCount: number;
}> {
  try {
    const text = await readFile(path, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    let title = "(untitled)";
    let firstUserText = "";
    let mode: AgentMode | undefined;
    let model: string | undefined;
    let messageCount = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as Event;
        if (e.type === "message") {
          if (e.role === "user" || e.role === "assistant") messageCount++;
          if (e.role === "user" && !firstUserText) {
            const first = e.content.find((b) => b.type === "text");
            if (first && first.type === "text") firstUserText = first.text;
          }
          if (e.role === "assistant" && e.model) model = e.model;
        } else if (e.type === "mode") {
          mode = e.mode;
        }
      } catch {
 /* skip */
      }
    }
 // Prefer sidecar title.
    const sidecar = await loadTitleFromDisk(id);
    if (sidecar) title = sidecar;
    else if (firstUserText) title = firstUserText.slice(0, 80);
    const cwd = await loadCwdFromDisk(id);
    return { title, cwd, mode, model, messageCount };
  } catch {
    return { title: "(untitled)", messageCount: 0 };
  }
}

export async function readSessionSearchCorpus(id: string): Promise<string> {
  try {
    const text = await readFile(sessionPath(id), "utf-8");
    const lines = text.split("\n").slice(0, 200);
    const out: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Event;
        if (e.type === "message") {
          for (const b of e.content) {
            if (b.type === "text") out.push(b.text);
          }
        }
      } catch {
 /* skip */
      }
    }
    return out.join("\n");
  } catch {
    return "";
  }
}

export function renderMarkdownTranscript(events: Event[], id: string): string {
  const out: string[] = [];
  out.push(`# Session ${id}`, "");
  out.push(`Exported at ${new Date().toISOString()}`, "");
  const first = events.find((e) => e.cwd || e.gitBranch || e.version);
  if (first) {
    const bits: string[] = [];
    if (first.cwd) bits.push(`cwd: \`${first.cwd}\``);
    if (first.gitBranch) bits.push(`branch: \`${first.gitBranch}\``);
    if (first.version) bits.push(`core: ${first.version}`);
    if (bits.length) out.push(bits.join(" · "), "");
  }
  let msgIdx = 0;
  for (const e of events) {
    const when = e.ts ? ` · ${new Date(e.ts).toISOString()}` : "";
    if (e.type === "message") {
      msgIdx++;
      const speaker = e.role === "user" ? "**User**" : "**Assistant**";
      out.push(`## Turn ${msgIdx} — ${speaker}${when}`);
      if (e.model) out.push(`_model: ${e.model}_`, "");
      else out.push("");
      for (const b of e.content) {
        if (b.type === "reasoning") {
          out.push("<details><summary>Thinking</summary>", "");
          out.push(b.text.trim(), "");
          out.push("</details>", "");
        } else if (b.type === "text") {
          out.push(b.text.trim(), "");
        } else if (b.type === "tool_use") {
          out.push(`> _tool call: \`${b.name}\`_`);
          out.push("");
          out.push("```json");
          out.push(JSON.stringify(b.input ?? {}, null, 2));
          out.push("```", "");
        } else if (b.type === "tool_result") {
          out.push(`> _tool result${b.isError ? " (error)" : ""}_`);
          if (b.artifactRef) out.push(`> artifact: \`${b.artifactRef}\``);
          out.push("");
          const c = b.content.length > 1500
            ? b.content.slice(0, 1500) + `\n\n[...truncated ${b.content.length - 1500} chars]`
            : b.content;
          out.push("```");
          out.push(c);
          out.push("```", "");
        }
      }
    } else if (e.type === "tool_call") {
      out.push(`### Tool \`${e.name}\`${when}`);
      out.push("");
      out.push("```json");
      out.push(JSON.stringify(e.input ?? {}, null, 2));
      out.push("```", "");
    } else if (e.type === "tool_result") {
      out.push(`### Result \`${e.name}\`${e.isError ? " (error)" : ""}${when}`);
      out.push("");
      if (e.artifactRef) out.push(`artifact: \`${e.artifactRef}\``, "");
      const c = e.content.length > 1500
        ? e.content.slice(0, 1500) + `\n\n[...truncated ${e.content.length - 1500} chars]`
        : e.content;
      out.push("```");
      out.push(c);
      out.push("```", "");
    } else if (e.type === "request") {
      const tokens = [
        e.inputTokens !== undefined ? `in=${e.inputTokens}` : null,
        e.outputTokens !== undefined ? `out=${e.outputTokens}` : null,
        e.ttftMs !== undefined ? `ttft=${e.ttftMs}ms` : null,
        `${e.durationMs}ms`,
        e.ok ? "ok" : "fail",
      ].filter(Boolean).join(" · ");
      out.push(`_request${e.model ? ` (${e.model})` : ""}: ${tokens}_`, "");
    } else if (e.type === "plan") {
      out.push("## Plan");
      out.push("");
      for (const s of e.steps) {
        out.push(`- \`${s.status}\` **${s.id}** — ${s.title}`);
      }
      out.push("");
    } else if (e.type === "compaction") {
      out.push(`## Compaction (${e.kind ?? "summary"})`);
      out.push("");
      out.push(e.summary, "");
    } else if (e.type === "mode") {
      out.push(`_mode → ${e.mode}_`);
      out.push("");
    } else if (e.type === "error") {
      out.push(`> _error:_ ${e.message}`);
      out.push("");
    }
  }
  return out.join("\n");
}

export function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

/** Human-readable record of the turns compaction removed from the session
 * file. Append-only, so it holds every compacted turn, oldest first. */
export function historyArchivePath(id: string): string {
  return join(SESSIONS_DIR, `${id}.history.md`);
}

export function titleSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.title`);
}

export function cwdSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.cwd`);
}

export function stateSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.state`);
}

/** Read the pin/archive sidecar. Missing/corrupt → empty state. */
export async function loadSessionState(id: string): Promise<SessionState> {
  try {
    const raw = JSON.parse(await readFile(stateSidecarPath(id), "utf-8")) as unknown;
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      return {
        pinned: o.pinned === true || undefined,
        archived: o.archived === true || undefined,
      };
    }
  } catch {
    /* missing or corrupt */
  }
  return {};
}

async function writeSessionState(id: string, state: SessionState): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
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

export async function loadTitleFromDisk(id: string): Promise<string | null> {
  try {
    const t = await readFile(titleSidecarPath(id), "utf-8");
    return t.trim() || null;
  } catch {
    return null;
  }
}



/** Persist the workspace cwd for a session (used by listSessions filtering). */
export async function persistSessionCwd(id: string, cwd: string): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(cwdSidecarPath(id), normalizeCwd(cwd), "utf-8");
}

export async function loadCwdFromDisk(id: string): Promise<string | undefined> {
  try {
    const t = await readFile(cwdSidecarPath(id), "utf-8");
    const v = t.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Normalize cwd for comparison (strip trailing slashes). */
export function normalizeCwd(cwd: string): string {
  const t = cwd.trim();
  if (!t || t === "/") return t || "/";
  return t.replace(/\/+$/, "");
}

export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a === "(unknown)" || b === "(unknown)") return false;
  return normalizeCwd(a) === normalizeCwd(b);
}

/** Delete a session's persisted file + sidecar. Useful for test cleanup. */
export async function deleteSession(id: string): Promise<void> {
  for (const p of [sessionPath(id), titleSidecarPath(id), cwdSidecarPath(id), stateSidecarPath(id), historyArchivePath(id)]) {
    try {
      await unlink(p);
    } catch {
 /* ignore */
    }
  }
}

/**
 * Resolve a "sticky" model from session history. Priority:
 * 1. On resume (`sessionId` given): the model that session last used.
 * 2. Otherwise: the newest session in the SAME cwd that recorded a model.
 * 3. Otherwise: the newest session in ANY cwd that recorded a model.
 * Returns undefined when no session history carries a model (caller then
 * falls back to the config default). Best-effort — never throws.
 */
async function resolveSessionModel(
  cwd: string,
  sessionId?: string,
): Promise<string | undefined> {
  try {
    const all = await listSessions(); // newest-first, every workspace
    if (sessionId) {
      const self = all.find((s) => s.id === sessionId);
      if (self?.model) return self.model;
    }
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
 // Opt-in provider-accurate tokenizer. Best-effort and process-wide: when
 // `preciseTokens` is set and the optional `gpt-tokenizer` package is
 // installed, all token budgeting switches to real BPE counts; otherwise
 // the built-in heuristic stays active. Safe to call repeatedly.
  if (config.preciseTokens) {
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
  if (opts.pluginRuntimes !== false) {
    const log = createLogger("plugins");
    try {
      const init = await initPluginRuntimes(opts.cwd, { existingRuntime: runtime });
      runtime = runtime ?? init.defaultRuntime;
      for (const [plugin, message] of init.errors) {
        log.warn(`plugin ${plugin}: runtime module failed to load — ${message}`);
      }
    } catch (err) {
 // Conflicting plugin defaults and the like: a misconfigured plugin must
 // not make the session unusable, so fall back to the default loop.
      log.warn(`plugin runtime init failed — ${(err as Error).message}`);
    }
  }

 // Expand the chosen model into a FULLY-RESOLVED config. This is the crucial
 // step: a model name alone (from opts, sticky history, or config.model) is
 // not enough — the provider/apiKey/baseURL live in the matching `providers`
 // preset. Without expanding it, buildSingleProvider falls back to the
 // Anthropic default and fails with "missing API key" until the user manually
 // switches models (which runs this same expansion via setModel). Do it here
 // so a fresh/resumed session works on the first message.
  let resolvedConfig = config;
  let resolvedModel = model ?? "";
  const target = model ?? resolveDefaultModel(config)?.model;
  if (target) {
    const { providerId } = resolveModelTarget(config, target);
    const applied = applyProviderAndModel(config, providerId, target);
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
 // Empty string forces Session to keep config.model; avoid inventing a
 // vendor id the user never configured (was "claude-sonnet-4-5").
    model: resolvedModel || config.model || "",
  });
  await session.init();
  return session;
}

// SQLite metadata index (Scheme B). Opened lazily and cached per process. The
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
 * List session summaries. Each summary includes the auto-title (or a
 * truncated prefix of the first user message), the model, the current
 * mode, the message count, and the mtime. Sessions can be filtered by
 * cwd or by a substring search via `searchSessions`.
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
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    const path = join(SESSIONS_DIR, name);
    try {
      const st = await stat(path);
      const derived = await extractTitleAndMeta(path, id);
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

/**
 * Search session summaries by title or content. `query` is a plain string;
 * it is matched case-insensitively against the title, the first user
 * message, and the last assistant message. Returns matching summaries
 * sorted by recency.
 */
export async function searchSessions(
  query: string,
  opts: { cwd?: string; limit?: number } = {}
): Promise<SessionSummary[]> {
  // Fast path: metadata-only search via the index (title / cwd / first user
  // message). Does not scan full message bodies — a deliberate scope choice
  // (Scheme B). When the index is off, the full-corpus fallback below runs.
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

/**
 * Export a session transcript as either a human-readable markdown
 * document or a JSONL dump (the same shape as the persisted event log).
 * Markdown output renders user/assistant turns as blockquotes, lists each
 * tool call + result, and surfaces plan + mode events as their own
 * sections. JSONL output streams the events one per line for piping
 * into other tools.
 */
export async function exportSession(
  id: string,
  format: SessionExportFormat
): Promise<string> {
  let events: Event[] = [];
  try {
    const text = await readFile(sessionPath(id), "utf-8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as Event);
      } catch {
 /* skip */
      }
    }
  } catch {
 /* empty */
  }
  if (format === "jsonl") {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
  return renderMarkdownTranscript(events, id);
}
