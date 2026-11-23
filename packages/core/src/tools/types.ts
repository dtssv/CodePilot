// Tool framework. Tools declare a JSON schema, a permission tier and an
// async execute function. The agent loop invokes them with parsed input.

import type { z } from "zod";
import { zodToJsonSchema as zodToJsonSchemaLib } from "zod-to-json-schema";
import type { ContentBlock, QuestionRequest, QuestionAnswers } from "../types.js";
import type { ResolvedSandbox } from "../sandbox/sandbox.js";
import { invalidateProviderToolDef } from "./schemaCacheMemo.js";

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
  /** Reserved — no built-in tool reads this today (bash uses a dedicated child
   * so timeout can detach). Session may still own a PersistentShell for future use. */
  persistentShell?: { run(command: string, opts: { timeout?: number; signal?: AbortSignal }): Promise<import("../sandbox/persistentShell.js").PersistentShellResult> };
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
   * File-observation store (staleness guard for blind replaces). Read tools
   * call `observeFile` after a read; blind writers (`write_file`, notebook)
   * call `checkFileFresh` before mutating. Surgical editors (`edit_file`,
   * apply_patch Update) skip it — live-disk match is the gate. Optional.
   */
  observeFile?: (
    absPath: string,
    stat: { mtimeMs: number; size: number },
    contentHash?: string,
    readWindow?: import("../workspace/fsObservation.js").ReadWindow,
  ) => void;
  /** True when `read_file` can skip re-reading (same path+window, still fresh). */
  isUnchangedRead?: (
    absPath: string,
    window: import("../workspace/fsObservation.js").ReadWindow,
    currentStat: { mtimeMs: number; size: number },
  ) => boolean;
  checkFileFresh?: (
    absPath: string,
    currentStat: { mtimeMs: number; size: number } | null,
    currentContentHash?: string,
    opts?: import("../workspace/fsObservation.js").CheckFreshOptions,
  ) => import("../workspace/fsObservation.js").FreshnessResult;
  reobserveFile?: (
    absPath: string,
    stat: { mtimeMs: number; size: number },
    contentHash?: string,
  ) => void;
  /** Run after a successful write: configured formatters, then new
   * language-server errors. Returns a note for the tool result ("" if none). */
  postWrite?: import("../workspace/postWrite.js").PostWrite;
  /** Nested runner for `code_mode.tools.call`. Set by the agent loop → full
   * permission + hooks path. Absent in tests → direct execute after mode check. */
  callDeferredTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  /** Collaboration mode for nested deferred calls / mode deny. */
  agentMode?: import("../types.js").AgentMode;
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
   * When set, overrides the permission-level parallel rule for this call.
   * Return true only when the call is safe to run concurrently with other
   * tools in the same turn. Fail-closed: throw/undefined → exclusive.
   * Default (omit): `read` / `network` parallelize; `write` / `execute` do not.
   */
  concurrencySafe?(input: z.infer<S>): boolean;
  /** Origin of the tool. Builtins omit this (treated as builtin for cache sort). */
  source?: "builtin" | "mcp" | "plugin";
  /** For `source: "mcp"`: the server + original tool name + raw JSON schema,
   * used by the `mcp` meta-tool to describe/call it on demand. `destructiveHint`
   * is the server's SELF-REPORTED "this may perform destructive updates" flag;
   * the permission engine uses it only to make approval stricter (ask instead
   * of silently allowing a network-tier MCP call) — never to grant privilege. */
  mcpMeta?: {
    server: string;
    toolName: string;
    jsonSchema: unknown;
    destructiveHint?: boolean;
  };
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
   * before the new set is re-registered. Also drops the provider-schema memo
   * so a re-register does not reuse a stale compacted schema. */
  unregister(name: string): boolean {
    const gone = this.tools.delete(name);
    if (gone) invalidateProviderToolDef(name);
    return gone;
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
