// Session utilities: standalone helpers extracted from the monolithic
// session.ts. These functions are NOT part of the Session class — they
// cover persistence paths, auto-titling, provider construction, session
// listing/search/export, and small pure helpers used across the codebase.

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
import { Session } from "./session.js";
import { initPluginRuntimes } from "./plugins.js";
import { createLogger } from "./logger.js";
import { resolveDefaultModel, resolveModelTarget, applyProviderAndModel } from "./providerCatalog.js";

export const SESSIONS_DIR = join(homedir(), ".codepilot", "sessions");

/** Extended session summary with mode, model, and message count. The
 * base `SessionSummary` (in `types.ts`) is kept small for back-compat;
 * `listSessions` and `searchSessions` now return `RichSessionSummary`. */
export interface RichSessionSummary extends SessionSummary {
  mode?: AgentMode;
  model?: string;
  messageCount: number;
}

/** Resolved at call time — useful for tests that change HOME. */
export function getSessionsDir(): string {
  return join(homedir(), ".codepilot", "sessions");
}

/** Format for `exportSession`. */
export type SessionExportFormat = "markdown" | "jsonl";

export function sanitizeTitle(raw: string): string | null {
  if (!raw) return null;
  let t = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
 // Strip leading numbering like "1. " or "- ".
  t = t.replace(/^[\-\d.\)\s]+/, "");
 // Collapse whitespace.
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
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
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "(untitled)";
 // Prefer the first sentence.
  const firstSentence = clean.split(/[.?!。？！\n]/)[0] ?? clean;
  return firstSentence.slice(0, 60);
}

export async function callTitleModel(
  provider: ChatProvider,
  userText: string,
  model: string | undefined
): Promise<string | null> {
  const sys = `You generate short, neutral session titles (≤10 Chinese chars or ≤60 ASCII chars). No punctuation, no quotes, no preamble.`;
  const prompt = userText.slice(0, 2000);
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
  const joined = collected.join("").trim();
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
  for (const p of [sessionPath(id), titleSidecarPath(id), cwdSidecarPath(id), historyArchivePath(id)]) {
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
  const all = await listSessions(opts.cwd);
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
