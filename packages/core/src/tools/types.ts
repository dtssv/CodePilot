// Tool framework. Tools declare a JSON schema, a permission tier and an
// async execute function. The agent loop invokes them with parsed input.

import type { z } from "zod";
import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";
import type { ContentBlock, QuestionRequest, QuestionAnswers } from "../types.js";
import type { ResolvedSandbox } from "../sandbox.js";

export type PermissionLevel = "read" | "write" | "execute" | "network";

export interface ToolContext {
  cwd: string;
 /** Identity of the running session / sub-agent. Used to stamp ownership on
  * background jobs so `write_stdin` cannot write to a job started by a
  * DIFFERENT session that happens to share this cwd (parallel sub-agents on a
  * fallback shared cwd). Absent in minimal contexts → no ownership checks. */
  sessionId?: string;
  signal?: AbortSignal;
 /** Stash helper to spill large tool outputs to disk. */
  artifact(blob: string | Uint8Array, hint?: string): Promise<string>;
 /** Resolve an artifact reference back to its contents. */
  readArtifact(ref: string): Promise<string>;
 /**
 * Active sandbox policy. File tools MUST call `assertPathAllowedAsync`
 * before any I/O; bash wraps commands via `wrapCommand`. Optional so
 * test harnesses can construct minimal contexts (absent = mode "off").
 */
  sandbox?: ResolvedSandbox;
 /**
 * Structured user-question channel (ask_user_question / plan_done).
 * Absent in headless sessions — tools must degrade gracefully.
 */
  askUser?: (req: QuestionRequest) => Promise<QuestionAnswers>;
 /**
 * Persistent shell for foreground `bash` calls, so `cd`, `export`, and
 * background jobs persist across calls. Absent in test harnesses.
 */
  persistentShell?: { run(command: string, opts: { timeout?: number; signal?: AbortSignal }): Promise<import("../persistentShell.js").PersistentShellResult> };
 /**
 * LSP / language-server diagnostics provider (host-supplied). When
 * present, the `diagnostics` tool reads from it; otherwise the tool
 * reports that diagnostics are unavailable and suggests `bash`.
 */
  diagnosticsProvider?: import("./diagnostics.js").DiagnosticsProvider;
 /**
 * The session's resolved config (read-only). Tools that need
 * config-driven behaviour (e.g. web_fetch's per-domain allowlist) read
 * from here. Optional so minimal test contexts still type-check.
 */
  config?: import("../types.js").CodepilotConfig;
 /** Current sub-agent nesting depth (0 at top level). The `task` tool
 * refuses to spawn beyond the configured max depth to prevent
 * unbounded recursion. */
  subagentDepth?: number;
 /**
   * Side channel for auxiliary session events (e.g. `team_message`).
   * Bypasses the provider transcript so a tool can narrate internal work
   * without spending model context. Absent in minimal contexts.
   */
  emitEvent?: (e: import("../types.js").Event) => void | Promise<void>;
  /** Id of the tool call being executed (lets `task` tag sub-agent events). */
  toolCallId?: string;
  /**
   * Directories where intentional project deliverables should land for this
   * task (defaults to cwd; extended from path tokens in user prompts).
   * Distinct from sandbox writable roots.
   */
  deliveryRoots?: string[];
  /** Session scratch dir — exempt from delivery-root write guard. */
  scratchDir?: string;
  /** Project state root (~/.codepilot/projects/<hash>/) — also exempt. */
  projectStateDir?: string;
  /** Add a delivery root mid-turn after the user approves an out-of-root write. */
  addDeliveryRoot?: (dir: string) => void | Promise<void>;
  /**
   * Expand OS-sandbox writable roots (same as permission "Allow folder").
   * When the user approves a delivery-root add, call this too — otherwise
   * Seatbelt/bwrap still blocks the write even though delivery roots grew.
   */
  expandSandboxWritable?: (
    dir: string,
    opts: { persist: boolean },
  ) => Promise<void> | void;
  /**
   * File-observation store (read-before-write + staleness guard). Read tools
   * call `observeFile` after a read; write tools call `checkFileFresh` before
   * mutating and `reobserveFile` after. Optional — tools fall back to no guard.
   */
  observeFile?: (
    absPath: string,
    stat: { mtimeMs: number; size: number },
    contentHash?: string,
  ) => void;
  checkFileFresh?: (
    absPath: string,
    currentStat: { mtimeMs: number; size: number } | null,
    currentContentHash?: string,
  ) => import("../fsObservation.js").FreshnessResult;
  reobserveFile?: (
    absPath: string,
    stat: { mtimeMs: number; size: number },
    contentHash?: string,
  ) => void;
}

export interface ToolResult {
 /** Required plain-text content (sent back to the model as a tool_result). */
  content: string;
  isError?: boolean;
 /** Optional reference to a file on disk holding larger content. */
  artifactRef?: string;
 /** Optional structured blocks for richer UI use; not required. */
  blocks?: ContentBlock[];
 /** Optional images returned by image-capable tools (e.g. read_image).
 * The agent loop emits them alongside the tool_result as image content
 * blocks so a multimodal model can see them. Non-multimodal models
 * simply never receive them (provider strips unsupported blocks). */
  images?: { mediaType: string; base64: string }[];
}

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  permission: PermissionLevel;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
    /**
   * Origin of the tool: "mcp" (external MCP server; hidden from the provider
   * tool list under lazy discovery, reached via the `mcp` meta-tool), "plugin"
   * (contributed via `RuntimeToolkit`), or undefined = built-in.
   */
  source?: "mcp" | "plugin";
  /** For `source: "mcp"`: the server + original tool name + raw JSON schema,
   * used by the `mcp` meta-tool to describe/call it on demand. */
  mcpMeta?: { server: string; toolName: string; jsonSchema: unknown };
}

/**
 * Convert a Zod schema to JSON Schema via `zod-to-json-schema` (`openApi3`
 * target: additionalProperties false, inlined, `$schema` dropped), then
 * convert draft-04 boolean exclusive bounds to numeric draft-2020-12 form.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const out = zodToJsonSchemaLib(schema, {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete out.$schema;
  normalizeExclusiveBounds(out);
  return out;
}

/**
 * Rewrite draft-04 boolean exclusive bounds to numeric draft-2020-12 form
 * (OpenAI/GLM): `{min: X, exclusiveMin: true}` → `{exclusiveMin: X}`;
 * a redundant `exclusive*: false` is dropped.
 */
function normalizeExclusiveBounds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) normalizeExclusiveBounds(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;

  for (const [bound, excl] of [
    ["minimum", "exclusiveMinimum"],
    ["maximum", "exclusiveMaximum"],
  ] as const) {
    if (typeof o[excl] === "boolean") {
      if (o[excl] === true && typeof o[bound] === "number") {
        o[excl] = o[bound];
        delete o[bound];
      } else {
        // `false` (or no paired numeric bound) → the boolean is noise; drop it.
        delete o[excl];
      }
    }
  }

  for (const key of Object.keys(o)) {
    if (key === "exclusiveMinimum" || key === "exclusiveMaximum") continue;
    normalizeExclusiveBounds(o[key]);
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register<S extends z.ZodTypeAny>(tool: ToolDef<S>): void {
    this.tools.set(tool.name, tool as unknown as ToolDef);
  }

 /** Remove a tool by name. Returns true if it was present. Used when an MCP
  * server announces a tool-list change and its old tools must be dropped
  * before the new set is re-registered. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }
}
