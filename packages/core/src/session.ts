// Session: owns the tool registry, permissions, provider, and event log.
// Persists events as JSONL under ~/.codepilot/sessions/<id>.jsonl.

import { appendFile, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { runAgent, type AgentDeps } from "./agent.js";
import type {
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
} from "./tools/index.js";

export const SESSIONS_DIR = join(homedir(), ".codepilot", "sessions");

/** Resolved at call time — useful for tests that change HOME. */
export function getSessionsDir(): string {
  return join(homedir(), ".codepilot", "sessions");
}

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

      // Post-prompt compaction.
      await this.maybeCompact();
    } finally {
      this.cancelController = null;
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

  async fork(atEventIndex?: number): Promise<Session> {
    const newId = generateSessionId();
    const forked = new Session(newId, {
      cwd: this.cwd,
      config: this.config,
      model: this.model,
      systemPromptExtra: this.systemPromptExtra,
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
  }

  private async persistEvent(e: Event): Promise<void> {
    const path = sessionPath(this.id);
    await mkdir(SESSIONS_DIR, { recursive: true });
    await appendFile(path, JSON.stringify(e) + "\n", "utf-8");
  }

  private async rebuildSystemPrompt(): Promise<void> {
    const memory = summariseMemory(await readMemory(this.cwd));
    const plan = extractPlan(this.events);
    const toolNames = this.toolRegistry.names();
    this.systemPromptCache = await buildSystemPrompt({
      cwd: this.cwd,
      memory,
      plan,
      toolNames,
      extra: this.systemPromptExtra,
      model: this.model,
      provider: this.config.provider ?? "anthropic",
    });
  }

  private async maybeCompact(): Promise<void> {
    const window = this.config.contextWindow ?? 120_000;
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

export async function listSessions(
  cwd?: string
): Promise<SessionSummary[]> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    const path = join(SESSIONS_DIR, name);
    try {
      const st = await stat(path);
      const firstUserText = await extractTitle(path);
      summaries.push({
        id,
        title: firstUserText,
        updatedAt: st.mtimeMs,
        cwd: cwd ?? "(unknown)",
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

async function extractTitle(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf-8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Event;
        if (e.type === "message" && e.role === "user") {
          const first = e.content.find((b) => b.type === "text");
          if (first && first.type === "text") {
            return first.text.slice(0, 80);
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return "(untitled)";
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`);
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
