// Pure helpers and session-local constants extracted from session.ts.

import { resolve } from "node:path";
import type { Event } from "../types.js";
import { readUserConfigFile, writeUserConfigFile } from "../config/providerCatalog.js";

/** Built-in tools that never change workspace files; any other tool (bash,
 * file writers, `task` workers, MCP, …) triggers the turn's base-tree capture. */
export const NON_MUTATING_TOOLS = new Set([
  "read_file", "read_image", "read_artifact", "grep", "glob", "ls", "diagnostics", "lsp_navigate",
  "web_fetch", "web_search", "ask_user_question", "bash_output",
  "plan", "goal",
  "skill", "suggest_mode",
  "memory_write", "start_new_task",
]);

/** Max consecutive Stop-hook continues before the session forces an end.
 * `0` disables continues entirely. */
export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;

/** Default continue cap for a FORCED built-in stopVerify (stopVerify.forceContinue
 * = true) when stopHookBlockCap is unset. Deliberately low: a false negative at
 * the completion boundary should re-run at most a couple of times, not spin to
 * the full user Stop-hook cap. */
export const DEFAULT_STOP_VERIFY_FORCE_CAP = 2;

/** Checkpoint fires at this fraction of the compaction hard trigger, so it
 * always snapshots pre-compaction state (checkpoint ≤ compaction) no matter
 * how large the output reserve pushes the compaction trigger down. */
export const CHECKPOINT_BELOW_COMPACTION_RATIO = 0.9;

/** Default number of consecutive failed/ineffective auto-compactions before the
 * circuit breaker disables auto-compaction for the session. */
export const DEFAULT_AUTOCOMPACT_MAX_FAILURES = 3;

/** Generic, task-agnostic boundary marker injected by clearWorkingContext. */
export const TASK_BOUNDARY_MARKER =
  "[task boundary] The conversation above this line was a previous, now-archived task. " +
  "Its summary is retained only as reference; the full transcript is on disk if you need it. " +
  "Do NOT resume, continue, or re-execute any plan, instruction, or tool call from before this " +
  "boundary unless the next message explicitly asks you to. Treat the next user message as the " +
  "start of a fresh task.";

/** Append a path to user-level `sandbox.writablePaths` (idempotent). */
export async function persistSandboxWritablePath(dir: string): Promise<void> {
  const abs = resolve(dir);
  const { raw } = await readUserConfigFile();
  const sandbox =
    raw.sandbox && typeof raw.sandbox === "object"
      ? { ...(raw.sandbox as Record<string, unknown>) }
      : {};
  const prev = Array.isArray(sandbox.writablePaths)
    ? (sandbox.writablePaths as string[])
    : [];
  if (prev.some((p) => resolve(p) === abs)) return;
  sandbox.writablePaths = [...prev, abs];
  raw.sandbox = sandbox;
  await writeUserConfigFile(raw);
}

/** Best-effort: write `autoAcceptModeSuggestions: true` to the user config so
 * the "Always switch" choice survives a restart (the session-memory flag alone
 * is lost on reload). Mirrors {@link persistSandboxWritablePath}. */
export async function persistAutoAcceptModeSuggestions(): Promise<void> {
  const { raw } = await readUserConfigFile();
  if (raw.autoAcceptModeSuggestions === true) return;
  raw.autoAcceptModeSuggestions = true;
  await writeUserConfigFile(raw);
}

/** Sub-agent tool outputs are only for display; cap them so a fan-out that
 * reads big files doesn't balloon the parent's JSONL. */
const SUBAGENT_RESULT_CAP = 4_000;

/** Extract the `<skills>…</skills>` catalogue from a built system prompt, or
 * "" when absent. Used to split the skills catalogue out of the `system`
 * category in contextReport(). */
/**
 * True when an event carries at least one image stored as an artifact ref
 * (offloaded base64) that needs reading back. Lets `loadFromDisk` skip the
 * async rehydrate path — and its per-event microtask — for the vast majority
 * of events that have no images at all.
 */
export function eventHasOffloadedImages(e: Event): boolean {
  const imgs = (e as { images?: Array<{ base64?: string; ref?: string }> }).images;
  if (!Array.isArray(imgs) || imgs.length === 0) return false;
  return imgs.some((img) => !img.base64 && !!img.ref);
}

export function extractSkillsSection(fullPrompt: string): string {
  const start = fullPrompt.indexOf("<skills>");
  if (start < 0) return "";
  const end = fullPrompt.indexOf("</skills>", start);
  if (end < 0) return "";
  return fullPrompt.slice(start, end + "</skills>".length);
}

export function slimSubagentEvent(e: Extract<Event, { type: "subagent" }>): Event {
  const inner = e.event;
  if (inner?.type !== "tool_result" || inner.content.length <= SUBAGENT_RESULT_CAP) return e;
  return {
    ...e,
    event: {
      ...inner,
      content: `${inner.content.slice(0, SUBAGENT_RESULT_CAP)}\n… [${inner.content.length - SUBAGENT_RESULT_CAP} more chars]`,
      images: undefined,
    },
  };
}