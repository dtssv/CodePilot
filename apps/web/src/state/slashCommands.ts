// Client-side slash-command interpreter for the web/embedded surfaces.
//
// Mirrors codex's model (verified in codex-rs/tui/src/chatwidget/slash_dispatch.rs):
// a slash command is primarily a LOCAL action (switch mode, compact, clear,
// open a picker) — NOT a prompt to the model. When the command carries trailing
// args (e.g. `/plan add a test`), we perform the local action first, then send
// the remaining text to the model (codex's `SlashCommand::Plan if !trimmed.is_empty()`
// path). With no args, only the local action runs — no LLM call.
//
// Commands we don't recognise as local (project/user markdown commands) are
// left to flow through to the server as a normal prompt, which expands them.

import type { AgentMode } from "@codepilot/core";
import type { Codepilot } from "./useCodepilot.js";

export interface SlashOutcome {
  /** True when the command was fully handled locally — do NOT send to model. */
  handled: boolean;
  /** Residual text to send to the model after a local action (e.g. the prompt
   * after `/plan <prompt>`). Empty when nothing should be sent. */
  forward?: string;
  /** Optional user-facing notice (e.g. "Switched to plan mode"). */
  notice?: string;
}

/** Parse `"/plan add tests"` → `{ name: "plan", args: "add tests" }`. */
export function parseSlash(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const m = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() };
}

const MODE_COMMANDS: Record<string, AgentMode> = {
  plan: "plan",
  agent: "agent",
  chat: "chat",
};

/**
 * Interpret a composer submission. Returns an outcome telling the caller
 * whether the text was handled locally and what (if anything) to still send.
 *
 * `ui` carries the client actions + optional UI hooks (open pickers). All are
 * optional so a minimal host degrades gracefully (unknown local command →
 * treated as not-local → sent as prompt).
 */
export async function interpretSlash(
  text: string,
  cp: Codepilot,
  ui: {
    openModelPicker?: () => void;
    openModePicker?: () => void;
    setNotice?: (text: string) => void;
    openPanel?: (name: string) => void;
  } = {},
): Promise<SlashOutcome> {
  const parsed = parseSlash(text);
  if (!parsed) return { handled: false };
  const { name, args } = parsed;
  const sessionId = cp.state.sessionId;

  // --- Mode switches: /plan, /agent, /chat. No args → switch only (no LLM).
  //     With args → switch, then forward the args to the model.
  const mode = MODE_COMMANDS[name];
  if (mode) {
    await cp.setMode(mode).catch(() => {});
    if (args) return { handled: true, forward: args, notice: `→ ${mode} mode` };
    ui.setNotice?.(`Switched to ${mode} mode`);
    return { handled: true, notice: `Switched to ${mode} mode` };
  }

  // --- /model [provider/model]: with an arg, set it; else open the picker.
  if (name === "model") {
    if (args) {
      const [a, b] = args.includes("/") ? [args.split("/")[0]!, args.split("/").slice(1).join("/")] : ["", args];
      await cp.setModel(b, a || undefined).catch(() => {});
      ui.setNotice?.(`Model → ${args}`);
    } else {
      ui.openModelPicker?.();
    }
    return { handled: true };
  }

  // --- /compact: manual compaction, same task. No LLM turn.
  if (name === "compact") {
    if (sessionId) await cp.client.sessionCompact(sessionId).catch(() => {});
    ui.setNotice?.("Compacting conversation…");
    return { handled: true };
  }

  // --- /clear: task boundary — archive context, clean slate. No LLM turn.
  if (name === "clear") {
    if (sessionId) {
      const r = await cp.client.sessionClearContext(sessionId, "user ran /clear").catch(() => ({ cleared: false }));
      ui.setNotice?.(r.cleared ? "Cleared — prior context archived." : "Nothing to clear.");
    }
    return { handled: true };
  }

  // --- /undo, /redo: file-edit history. No LLM turn.
  if ((name === "undo" || name === "redo") && sessionId) {
    try {
      const r = name === "undo" ? await cp.client.undoSession(sessionId) : await cp.client.redoSession(sessionId);
      ui.setNotice?.(`${name}: ${r.label}`);
    } catch {
      ui.setNotice?.(`Nothing to ${name}.`);
    }
    return { handled: true };
  }

  // --- Panel-opening informational commands (mcp/hooks/agents/skills/…):
  //     surface a panel/notice locally; never a prompt.
  if (["mcp", "hooks", "agents", "skills", "context", "plugins", "sessions", "help"].includes(name)) {
    ui.openPanel?.(name);
    return { handled: true };
  }

  // Unknown command → not a known local action. Let it flow to the server,
  // which resolves project/user markdown commands (prompt-expanding) or echoes
  // an "unknown command" hint. The caller forwards the full text unchanged.
  return { handled: false };
}
