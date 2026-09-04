// Session: owns the tool registry, permissions, provider, and event log.
// Persists events as JSONL under ~/.codepilot/sessions/<id>.jsonl.
//
// Enhancements (2025-Q1):
//   - Automatic session title: derived from the first user message; if a
//     small model is configured, a tighter 10-char title is produced and
//     cached. The model is asked via the smallModel provider; failures fall
//     back to a deterministic prefix.
//   - Checkpoint integration: a CheckpointHook is initialised in `init()`;
//     on each prompt the hook inspects the event log and writes a fresh
//     checkpoint when triggered (token count, round count).
//   - searchSessions / exportSession: pure helpers, useful from CLI and
//     from `listSessions` enrichments.

import { appendFile, mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentDeps } from "./agent.js";
import type {
  AgentMode,
  CodepilotConfig,
  Event,
  ImageAttachment,
  PermissionDecision,
  PermissionRequest,
  SessionOptions,
  SessionSummary,
} from "./types.js";
import { ToolRegistry } from "./tools/types.js";
import { z } from "zod";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { readMemory, FileMemorySink, summariseMemory } from "./memory.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { loadConfig } from "./config.js";
import { compact, shouldCompact, type CompactionOptions } from "./compaction.js";
import { extractPlan } from "./compaction.js";
import { AnthropicProvider, OpenAIProvider, CopilotProvider } from "./providers/index.js";
import { createSubagentRunner } from "./subagent.js";
import { McpManager } from "./mcp.js";
import {
  bashTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  lsTool,
  planUpdateTool,
  memoryWriteTool,
  readArtifactTool,
  taskTool,
  filterToolsByModeFromRegistry,
} from "./tools/index.js";
import { estimateTokens, lookupContextWindow, resolveCompactionThreshold } from "./tokens.js";
import {
  shouldCheckpoint as shouldCheckpointFn,
  writeCheckpoint,
  readCheckpoint,
  summariseCheckpointForPrompt,
  checkpointPath,
  makeCheckpointHook,
  type CheckpointHook,
  type CheckpointOptions,
} from "./checkpoints.js";
import type { ChatProvider } from "./providers/types.js";

export const SESSIONS_DIR = join(homedir(), ".codepilot", "sessions");

/** Extended session summary with mode, model, and message count. The
 *  base `SessionSummary` (in `types.ts`) is kept small for back-compat;
 *  `listSessions` and `searchSessions` now return `RichSessionSummary`. */
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

export class Session {
  readonly id: string;
  readonly cwd: string;
  private readonly config: CodepilotConfig;
  private readonly model: string;
  private readonly systemPromptExtra: string | undefined;
  private readonly onPermissionRequest?: (
    req: PermissionRequest
  ) => Promise<PermissionDecision>;

  private events: Event[] = [];
  private listeners = new Set<(e: Event) => void>();
  private cancelController: AbortController | null = null;
  private toolRegistry: ToolRegistry;
  private artifacts: ArtifactStore;
  private permissions: PermissionEngine;
  private mcp: McpManager | null = null;
  private systemPromptCache: { staticPrefix: string; dynamicSuffix: string; full: string } | null = null;
  private disposed = false;
  /** Current Cursor-style collaboration mode (default "agent"). */
  private mode: AgentMode = "agent";
  /** Auto-title, generated after the first prompt. */
  private title: string | null = null;
  /** Cached checkpoint hook — initialised in `init()`. */
  private checkpointHook: CheckpointHook | null = null;

  constructor(
    id: string,
    opts: Required<Pick<SessionOptions, "cwd" | "config" | "model">> & SessionOptions
  ) {
    this.id = id;
    this.cwd = opts.cwd;
    this.config = opts.config ?? {};
    this.model = opts.model ?? this.config.model ?? "claude-sonnet-4-5";
    this.systemPromptExtra = opts.systemPromptExtra;
    this.onPermissionRequest = opts.onPermissionRequest;
    this.mode = opts.agentMode ?? opts.config.agentMode ?? "agent";
    this.toolRegistry = new ToolRegistry();
    this.artifacts = new ArtifactStore(join(opts.cwd, ".codepilot", "artifacts"));
    this.permissions = new PermissionEngine({
      permissionMode: this.config.permissionMode,
      autoApprove: this.config.autoApprove,
    });
  }

  /** Load from disk and configure registries. */
  async init(): Promise<void> {
    await this.artifacts.init();
    this.registerBuiltins();
    await this.loadFromDisk();
    await this.startMcp();
    await this.rebuildSystemPrompt();
    this.checkpointHook = makeCheckpointHook(this.cwd, this.id);
    // If we loaded events, the hook shouldn't immediately re-fire — mark
    // the boundary at the end of the loaded history.
    if (this.events.length > 0) {
      this.checkpointHook.lastCheckpointAt = this.events.length;
    }
    // If a checkpoint already exists for this session, prime the title from it.
    const existing = await readCheckpoint(this.cwd, this.id);
    if (existing) {
      const headerMatch = existing.match(/^#\s+(.+)$/m);
      if (headerMatch) {
        const candidate = headerMatch[1]!.replace(/^Checkpoint for\s+/, "").trim();
        if (candidate) this.title = candidate;
      }
    }
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    this.cancelController = new AbortController();
    try {
      const deps: AgentDeps = {
        provider: buildProvider(this.config),
        tools: this.toolRegistry,
        artifacts: this.artifacts,
        permissions: this.permissions,
        config: { ...this.config, model: this.model },
        cwd: this.cwd,
        systemPrompt: this.systemPromptCache ?? undefined,
        signal: this.cancelController.signal,
        agentMode: this.mode,
        onEvent: async (e) => {
          this.events.push(e);
          await this.persistEvent(e);
          this.notify(e);
        },
        onPermissionRequest: this.onPermissionRequest,
      };

      // Run the agent loop. Compaction may run between turns (driven by the
      // session after each prompt completes).
      await runAgent({ history: this.events, userText: text, images }, deps);

      // Auto-title after the first prompt completes.
      if (this.title == null) {
        await this.refreshTitle(text);
      }

      // Post-prompt compaction.
      await this.maybeCompact();

      // Post-prompt checkpoint.
      await this.maybeCheckpoint();
    } finally {
      this.cancelController = null;
    }
  }

  /**
   * Runtime collaboration-mode switch. Takes effect on the next `prompt()`
   * (and on tool dispatch — see `runOneTool`'s mode gate in agent.ts). The
   * system prompt is rebuilt so the new mode's guidance reaches the model
   * on the next turn. Emits a `mode` event so subscribers (and protocol
   * clients) can react immediately.
   */
  async setAgentMode(mode: AgentMode): Promise<void> {
    if (this.disposed) throw new Error("session disposed");
    if (this.mode === mode) return;
    this.mode = mode;
    await this.rebuildSystemPrompt();
    const ev: Event = { type: "mode", mode };
    this.events.push(ev);
    await this.persistEvent(ev);
    this.notify(ev);
  }

  /** Returns the current collaboration mode (default "agent"). */
  getAgentMode(): AgentMode {
    return this.mode;
  }

  /** Returns the auto-generated (or user-supplied) session title. */
  getTitle(): string | null {
    return this.title;
  }

  /** Override the session title (and persist it for `listSessions`). */
  async setTitle(title: string): Promise<void> {
    this.title = title;
    // Title is stored as a tiny sidecar so listSessions doesn't have to
    // re-parse the JSONL. Failures are non-fatal.
    try {
      await mkdir(SESSIONS_DIR, { recursive: true });
      await writeFile(titleSidecarPath(this.id), title, "utf-8");
    } catch {
      /* ignore */
    }
  }

  cancel(): void {
    this.cancelController?.abort();
  }

  subscribe(listener: (e: Event) => void): () => void {
    // Replay history first.
    for (const e of this.events) {
      try {
        listener(e);
      } catch {
        /* ignore listener errors */
      }
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEvents(): Event[] {
    return this.events.slice();
  }

  /** Returns a short summary of this session for list/search use. */
  async getSummary(): Promise<SessionSummary> {
    const path = sessionPath(this.id);
    let updatedAt = Date.now();
    try {
      const st = await stat(path);
      updatedAt = st.mtimeMs;
    } catch {
      /* default */
    }
    const title = this.title ?? (await loadTitleFromDisk(this.id));
    return {
      id: this.id,
      title: title ?? "(untitled)",
      updatedAt,
      cwd: this.cwd,
    };
  }

  /** Returns an enriched summary including mode/model/messageCount. The
   *  base SessionSummary is kept tight for back-compat; callers that want
   *  the rich fields use this method. */
  async getRichSummary(): Promise<RichSessionSummary> {
    const base = await this.getSummary();
    return {
      ...base,
      mode: this.mode,
      model: this.model,
      messageCount: countMessages(this.events),
    };
  }

  async fork(atEventIndex?: number): Promise<Session> {
    const newId = generateSessionId();
    const forked = new Session(newId, {
      cwd: this.cwd,
      config: this.config,
      model: this.model,
      systemPromptExtra: this.systemPromptExtra,
      agentMode: this.mode,
      onPermissionRequest: this.onPermissionRequest,
    });
    await forked.init();
    const slice = atEventIndex === undefined
      ? this.events
      : this.events.slice(0, atEventIndex);
    for (const e of slice) {
      forked.events.push(e);
      await forked.persistEvent(e);
    }
    await forked.rebuildSystemPrompt();
    if (this.title) {
      await forked.setTitle(this.title);
    }
    return forked;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    this.listeners.clear();
    if (this.mcp) {
      await this.mcp.stopAll();
      this.mcp = null;
    }
  }

  // -- internals ----------------------------------------------------------

  private notify(e: Event): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* swallow */
      }
    }
  }

  private registerBuiltins(): void {
    this.toolRegistry.register(bashTool);
    this.toolRegistry.register(readFileTool);
    this.toolRegistry.register(writeFileTool);
    this.toolRegistry.register(editFileTool);
    this.toolRegistry.register(globTool);
    this.toolRegistry.register(grepTool);
    this.toolRegistry.register(lsTool);
    this.toolRegistry.register(planUpdateTool);
    this.toolRegistry.register(memoryWriteTool);
    this.toolRegistry.register(readArtifactTool);
    this.toolRegistry.register(taskTool);

    // Wire the memory sink.
    memoryWriteTool.sink = new FileMemorySink(this.cwd);

    // Wire the subagent runner so `task` works.
    taskTool.runner = createSubagentRunner({
      cwd: this.cwd,
      config: this.config,
      model: this.model,
      // We intentionally pass a narrower tool set for sub-agents.
      buildToolRegistry: () => {
        const r = new ToolRegistry();
        r.register(readFileTool);
        r.register(globTool);
        r.register(grepTool);
        r.register(lsTool);
        r.register(readArtifactTool);
        return r;
      },
    });
  }

  private async startMcp(): Promise<void> {
    if (!this.config.mcpServers) return;
    this.mcp = new McpManager(this.config.mcpServers);
    try {
      await this.mcp.startAll();
      for (const t of this.mcp.listAllTools()) {
        // Register a thin wrapper tool.
        this.toolRegistry.register({
          name: `mcp__${t.server}__${t.name}`,
          description: `[mcp:${t.server}] ${t.description}`,
          inputSchema: jsonSchemaToZod(t.inputSchema),
          permission: "network",
          execute: async (input) => {
            const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
            const r = await this.mcp!.invoke(t.server, t.name, args);
            return { content: r.content, isError: r.isError };
          },
        });
      }
    } catch (err) {
      process.stderr.write(
        `[session] MCP startup failed: ${(err as Error).message}\n`
      );
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const path = sessionPath(this.id);
      const text = await readFile(path, "utf-8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          this.events.push(JSON.parse(line) as Event);
        } catch {
          /* skip malformed */
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    // Hydrate title from sidecar (if any).
    const t = await loadTitleFromDisk(this.id);
    if (t) this.title = t;
  }

  private async persistEvent(e: Event): Promise<void> {
    const path = sessionPath(this.id);
    await mkdir(SESSIONS_DIR, { recursive: true });
    await appendFile(path, JSON.stringify(e) + "\n", "utf-8");
  }

  private async rebuildSystemPrompt(): Promise<void> {
    const memory = summariseMemory(await readMemory(this.cwd));
    const plan = extractPlan(this.events);
    // The system prompt advertises the *mode-filtered* tool list, so the
    // model doesn't expect tools that aren't actually available.
    const visibleTools = filterToolsByModeFromRegistry(this.toolRegistry, this.mode);
    const toolNames = visibleTools.map((t) => t.name);
    // If a checkpoint exists for this session, append a short summary of
    // it to the system prompt. This is what enables a "resume" without
    // replaying the JSONL: the agent sees the last checkpoint's distilled
    // state plus the events added since the checkpoint boundary.
    const checkpoint = await readCheckpoint(this.cwd, this.id);
    const resumeNote = checkpoint
      ? `\n\n${summariseCheckpointForPrompt(checkpoint)}`
      : "";
    this.systemPromptCache = await buildSystemPrompt({
      cwd: this.cwd,
      memory,
      plan,
      toolNames,
      extra: (this.systemPromptExtra ?? "") + resumeNote,
      model: this.model,
      provider: this.config.provider ?? "anthropic",
      mode: this.mode,
    });
  }

  private async maybeCompact(): Promise<void> {
    const window = this.config.contextWindow ??
      lookupContextWindow(this.model).contextWindow;
    const decision = shouldCompact(this.events, { contextWindow: window });
    if (!decision.shouldCompact) return;
    const result = await compact(this.events, {
      contextWindow: window,
      // Use the small provider for summarisation (best-effort).
      summariser: buildSmallProvider(this.config),
      summaryModel: this.config.smallModel,
    } as CompactionOptions);
    if (result.events === this.events) return; // no change
    this.events = result.events;
    // Rewrite the file to match the new event list.
    const path = sessionPath(this.id);
    await mkdir(SESSIONS_DIR, { recursive: true });
    const text = this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(path, text, "utf-8");
    // Notify listeners of the new compaction event.
    const compactionEvent = this.events.find((e) => e.type === "compaction");
    if (compactionEvent) this.notify(compactionEvent);
    await this.rebuildSystemPrompt();
  }

  private async maybeCheckpoint(): Promise<void> {
    if (!this.checkpointHook) return;
    const threshold = this.config.contextWindow
      ? Math.floor(this.config.contextWindow * 0.8)
      : resolveCompactionThreshold(this.model, undefined);
    const trigger = this.checkpointHook.check(this.events, {
      tokenThreshold: threshold,
      turnsThreshold: 6,
    });
    if (!trigger.shouldCheckpoint) return;
    try {
      const result = await writeCheckpoint(this.cwd, this.id, this.events, {
        tokenThreshold: threshold,
        turnsThreshold: 6,
        summariser: buildSmallProvider(this.config),
        summaryModel: this.config.smallModel,
      });
      this.checkpointHook.hasCheckpoint = true;
      this.checkpointHook.lastCheckpointAt = this.events.length;
      // Clear the sidecar title if it duplicates the checkpoint header —
      // the checkpoint now carries the canonical title.
      if (this.title && result.bytes > 0) {
        const cp = await readCheckpoint(this.cwd, this.id);
        const m = cp?.match(/^#\s+Checkpoint for (.+)$/m);
        if (m && m[1] && m[1].length <= 60 && !this.title) {
          this.title = m[1];
        }
      }
    } catch (err) {
      process.stderr.write(
        `[session] checkpoint write failed: ${(err as Error).message}\n`
      );
    }
  }

  /** Produce a short title for the session. Tries the small model first,
   *  then falls back to a deterministic prefix of the first user text. */
  private async refreshTitle(firstUserText: string): Promise<void> {
    const fallback = deriveTitleFromText(firstUserText);
    let candidate: string | null = null;
    try {
      const provider = buildSmallProvider(this.config);
      candidate = await callTitleModel(provider, firstUserText, this.config.smallModel);
    } catch {
      /* ignore */
    }
    const title = sanitizeTitle(candidate ?? fallback);
    if (title) await this.setTitle(title);
  }
}

function sanitizeTitle(raw: string): string | null {
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

function deriveTitleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "(untitled)";
  // Prefer the first sentence.
  const firstSentence = clean.split(/[.?!。？！\n]/)[0] ?? clean;
  return firstSentence.slice(0, 60);
}

async function callTitleModel(
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

function countMessages(events: ReadonlyArray<Event>): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "message" && (e.role === "user" || e.role === "assistant")) n++;
  }
  return n;
}

export async function createSession(opts: SessionOptions): Promise<Session> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const config = { ...(await loadConfig(opts.cwd)), ...(opts.config ?? {}) };
  const id = opts.sessionId ?? generateSessionId();
  const model = opts.model ?? config.model;
  const session = new Session(id, {
    ...opts,
    config,
    model: model ?? "claude-sonnet-4-5",
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
        cwd: derived.cwd ?? cwd ?? "(unknown)",
        mode: derived.mode,
        model: derived.model,
        messageCount: derived.messageCount,
      });
    } catch {
      /* skip */
    }
  }
  // Filter by cwd when given.
  const filtered = cwd
    ? summaries.filter((s) => s.cwd === cwd || s.cwd === "(unknown)")
    : summaries;
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

async function readSessionSearchCorpus(id: string): Promise<string> {
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

function renderMarkdownTranscript(events: Event[], id: string): string {
  const out: string[] = [];
  out.push(`# Session ${id}`, "");
  out.push(`Exported at ${new Date().toISOString()}`, "");
  let msgIdx = 0;
  for (const e of events) {
    if (e.type === "message") {
      msgIdx++;
      const speaker = e.role === "user" ? "**User**" : "**Assistant**";
      out.push(`## Turn ${msgIdx} — ${speaker}`);
      out.push("");
      for (const b of e.content) {
        if (b.type === "text") {
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
    } else if (e.type === "plan") {
      out.push("## Plan");
      out.push("");
      for (const s of e.steps) {
        out.push(`- \`${s.status}\` **${s.id}** — ${s.title}`);
      }
      out.push("");
    } else if (e.type === "compaction") {
      out.push("## Compaction");
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

async function extractTitleAndMeta(
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
    return { title, cwd: undefined, mode, model, messageCount };
  } catch {
    return { title: "(untitled)", messageCount: 0 };
  }
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
}

function titleSidecarPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.title`);
}

async function loadTitleFromDisk(id: string): Promise<string | null> {
  try {
    const t = await readFile(titleSidecarPath(id), "utf-8");
    return t.trim() || null;
  } catch {
    return null;
  }
}

/** Delete a session's persisted file + sidecar. Useful for test cleanup. */
export async function deleteSession(id: string): Promise<void> {
  for (const p of [sessionPath(id), titleSidecarPath(id)]) {
    try {
      await unlink(p);
    } catch {
      /* ignore */
    }
  }
}

function generateSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

function buildProvider(config: CodepilotConfig) {
  const provider = config.provider ?? "anthropic";
  switch (provider) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
    case "copilot":
      return new CopilotProvider({});
    case "anthropic":
    default:
      return new AnthropicProvider({ apiKey: config.apiKey });
  }
}

function buildSmallProvider(config: CodepilotConfig) {
  const provider = config.provider ?? "anthropic";
  switch (provider) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
    case "copilot":
      return new CopilotProvider({});
    case "anthropic":
    default:
      return new AnthropicProvider({ apiKey: config.apiKey });
  }
}

// A tiny helper to convert a JSON Schema to a Zod schema. Only the features
// we actually expect from MCP servers (object with string/number/boolean
// properties, optional required array) are supported.
function jsonSchemaToZod(schema: Record<string, unknown>): import("zod").ZodTypeAny {
  return compileJsonSchema(schema);
}

function compileJsonSchema(schema: Record<string, unknown>): import("zod").ZodTypeAny {
  if (schema.type === "object" || schema.properties) {
    const shape: Record<string, import("zod").ZodTypeAny> = {};
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const [k, v] of Object.entries(props)) {
      let child = compileJsonSchema(v);
      if (!required.includes(k)) child = child.optional();
      shape[k] = child;
    }
    return z.object(shape).passthrough();
  }
  if (schema.type === "array") {
    return z.array(compileJsonSchema((schema.items as Record<string, unknown>) ?? {}));
  }
  if (schema.type === "number" || schema.type === "integer") return z.number();
  if (schema.type === "boolean") return z.boolean();
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    if (values.length === 0) return z.any();
    // Cast through unknown so TS doesn't reject the heterogeneous literal array.
    const literals = values.map((v) => z.literal(v as never));
    return z.union(literals as unknown as [import("zod").ZodTypeAny, import("zod").ZodTypeAny, ...import("zod").ZodTypeAny[]]);
  }
  return z.any();
}

// keep this re-export for typecheck on the unused parameter warning
void estimateTokens;
void shouldCheckpointFn;
void checkpointPath;
