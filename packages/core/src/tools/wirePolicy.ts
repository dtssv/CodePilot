// Which tools ride the provider `tools[]` array vs deferred discovery
// (code_mode tools.search / tools.call). Small direct
 // allowlist on the wire; MCP/plugin and other builtins stay off-prefix.

import type { ToolDef } from "./types.js";
import type { CodepilotConfig } from "../types.js";

/**
 * Native function-calling tools kept on the wire when `codeMode.deferredWire`
 * is active (default). Everything else is deferred.
 */
export const DIRECT_WIRE_TOOLS: ReadonlySet<string> = new Set([
  // Files
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "read_artifact",
  // Shell
  "bash",
  "bash_output",
  "bash_kill",
  "write_stdin",
  // Search (ls / read_image / suggest_mode are registered but deferred —
  // discover via code_mode tools.search / tools.call when needed)
  "grep",
  "glob",
  // Orchestration UX
  "task",
  "ask_user_question",
  "plan",
  "goal",
  "code_mode",
  // MCP meta (tools/prompts/resources) — one FC entry, not per-item tools
  "mcp",
]);

/** True when this tool may appear in the provider tools array under deferred wire. */
export function isDirectWireTool(tool: ToolDef | string): boolean {
  if (typeof tool === "string") return DIRECT_WIRE_TOOLS.has(tool);
  if (tool.source === "mcp" || tool.source === "plugin") return false;
  return DIRECT_WIRE_TOOLS.has(tool.name);
}

/** True when the tool is reachable only via code_mode / meta-tools. */
export function isDeferredWireTool(tool: ToolDef): boolean {
  return !isDirectWireTool(tool);
}

/**
 * Whether to shrink the wire set to {@link DIRECT_WIRE_TOOLS}.
 * Default on when code_mode is enabled; `deferredWire: false` or
 * `codeMode.enabled: false` restores the full advertise table.
 */
export function resolveDeferredWire(
  config: Pick<CodepilotConfig, "codeMode"> | undefined,
): boolean {
  if (config?.codeMode?.enabled === false) return false;
  return config?.codeMode?.deferredWire !== false;
}

/** Keep only direct-wire tools (order preserved). */
export function filterDirectWireTools(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter(isDirectWireTool);
}
