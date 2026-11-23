// Client-side slash-command interpreter. A slash command is primarily a local
// action (switch mode, compact, clear, picker); trailing args (e.g. `/plan add
// a test`) run the local action then send the rest to the model. Unrecognised
// commands flow to the server as a prompt.

import type { AgentMode, PermissionMode, PermissionPresetName } from "@codepilot/core";
import {
  applyThemeName,
  THEME_NAMES,
  type ThemeName,
} from "../surface.js";
import { savePermissionMode } from "../prefs.js";
import type { Codepilot } from "./useCodepilot.js";

/** Mirror of core `PERMISSION_PRESETS` — keep local so the web bundle does not
 * pull Node-only `@codepilot/core` runtime into the IDE embed build. */
const PERMISSION_PRESETS: Record<
  PermissionPresetName,
  { permissionMode: PermissionMode; description: string }
> = {
  safe: { permissionMode: "ask", description: "read-only sandbox, prompt for every tool" },
  standard: { permissionMode: "auto-edit", description: "workspace-write sandbox, auto-approve edits" },
  "full-access": { permissionMode: "yolo", description: "no sandbox, never prompt (trusted/unattended)" },
  "supervised-auto": {
    permissionMode: "auto",
    description: "workspace-write sandbox, classifier auto-approves benign calls and prompts for risky ones",
  },
};

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

export function parseRewindArgs(args: string): { count: number; files: boolean } {
  const parts = args.split(/\s+/).filter(Boolean);
  const n = Number(parts.find((p) => /^\d+$/.test(p)) ?? 1);
  return { count: Math.max(1, n), files: !parts.includes("--keep-files") };
}

export function rewindFileSummary(r: { restored: string[]; deleted: string[] }): string {
  const parts = [];
  if (r.restored.length) parts.push(`${r.restored.length} restored`);
  if (r.deleted.length) parts.push(`${r.deleted.length} deleted`);
  return parts.length ? ` — files: ${parts.join(", ")}` : "";
}

const MODE_COMMANDS: Record<string, AgentMode> = {
  plan: "plan",
  agent: "agent",
  chat: "chat",
};

const PERMISSION_MODES = new Set<PermissionMode>([
  "ask",
  "auto-edit",
  "yolo",
  "auto",
  "dont-ask",
]);

const PRESET_NAMES = new Set<PermissionPresetName>(
  Object.keys(PERMISSION_PRESETS) as PermissionPresetName[],
);

function parseExportArgs(args: string): { format: "markdown" | "jsonl"; outPath?: string } {
  const parts = args.split(/\s+/).filter(Boolean);
  let format: "markdown" | "jsonl" = "markdown";
  let outPath: string | undefined;
  for (const p of parts) {
    if (p === "jsonl" || p === "md" || p === "markdown") {
      format = p === "jsonl" ? "jsonl" : "markdown";
    } else if (!p.startsWith("-")) {
      outPath = p;
    }
  }
  return { format, outPath };
}

function triggerDownload(filename: string, body: string): void {
  try {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* download may be blocked in some hosts — caller still wrote to disk when possible */
  }
}

/**
 * Interpret a composer submission: returns whether handled locally and what to
 * still send. `ui` is all optional so a minimal host degrades gracefully
 * (unknown command → sent as prompt).
 */
export async function interpretSlash(
  text: string,
  cp: Codepilot,
  ui: {
    openModelPicker?: () => void;
    openModePicker?: () => void;
    setNotice?: (text: string) => void;
    openPanel?: (name: string) => void;
    /** Names of known LOCAL commands (kind === "local") advertised by the
     * `commands/list` RPC. A local command this surface can't yet carry out is
     * reported as unsupported instead of leaking to the model as a prompt — a
     * local action must never silently become a model turn. Prompt-expanding
     * markdown commands are NOT in this set, so they still flow to the server. */
    knownLocalNames?: ReadonlySet<string>;
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
      ui.setNotice?.("Pick a model");
    }
    return { handled: true };
  }

  // --- /retry: resend last user prompt.
  if (name === "retry") {
    await cp.retryLast?.().catch(() => {});
    ui.setNotice?.("Retrying last prompt…");
    return { handled: true };
  }

  // --- /provider: open Models settings (GUI) — not a separate picker here.
  if (name === "provider") {
    ui.openPanel?.("provider");
    return { handled: true };
  }

  // --- /schedule: open Schedule settings.
  if (name === "schedule") {
    ui.openPanel?.("schedule");
    return { handled: true };
  }

  // --- /compact [focus…]: manual compaction, same task. The optional focus
  //     text tells the summariser what to preserve this run. No LLM turn.
  if (name === "compact") {
    if (sessionId) await cp.client.sessionCompact(sessionId, args || undefined).catch(() => {});
    ui.setNotice?.(args ? `Compacting conversation (focus: ${args})…` : "Compacting conversation…");
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

  // --- /rewind [n] [--keep-files]: drop the last n prompts (and their file
  //     edits unless --keep-files), then reload the trimmed history.
  if (name === "rewind" && sessionId) {
    const opts = parseRewindArgs(args);
    try {
      const targets = await cp.client.rewindTargets(sessionId);
      const target = targets[targets.length - opts.count];
      if (!target) {
        ui.setNotice?.("Nothing to rewind.");
        return { handled: true };
      }
      const r = await cp.client.rewindSession(sessionId, { messageId: target.messageId, files: opts.files });
      await cp.resumeSession(sessionId);
      ui.setNotice?.(`Rewound ${r.turns} prompt(s) to "${r.text.slice(0, 60)}"${rewindFileSummary(r)}`);
    } catch (err) {
      ui.setNotice?.(`Rewind failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }

  // --- /init [--force]: scaffold AGENTS.md via workspace/init.
  if (name === "init") {
    try {
      const force = /\b--force\b/.test(args);
      const r = await cp.client.initWorkspace({ force });
      ui.setNotice?.(
        r.skipped
          ? `Already exists: ${r.path} (pass --force to overwrite)`
          : `Wrote ${r.path} — review and commit so future sessions inherit it.`,
      );
    } catch (err) {
      ui.setNotice?.(`Init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }

  // --- /gc-artifacts: reclaim unreferenced spilled artifacts for this project.
  if (name === "gc-artifacts") {
    if (!sessionId) {
      ui.setNotice?.("Open a session first.");
      return { handled: true };
    }
    try {
      const r = await cp.client.gcSessionArtifacts(sessionId);
      const kb = (r.bytesReclaimed / 1024).toFixed(1);
      ui.setNotice?.(
        r.removed === 0
          ? `Artifacts: nothing to reclaim (${r.scanned} on disk, ${r.referenced} referenced).`
          : `Reclaimed ${r.removed} artifact${r.removed === 1 ? "" : "s"} (${kb} KB); ${r.referenced} still referenced.`,
      );
    } catch (err) {
      ui.setNotice?.(`gc-artifacts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }

  // --- /resume [session-id]: resume a named session, else open the history panel.
  if (name === "resume") {
    if (args) {
      try {
        await cp.resumeSession(args);
        ui.setNotice?.(`Resumed ${args}`);
      } catch (err) {
        ui.setNotice?.(`Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      ui.openPanel?.("sessions");
    }
    return { handled: true };
  }

  // --- /goal <objective>: drive a long-horizon loop on the live session.
  if (name === "goal") {
    if (!args) {
      ui.setNotice?.("Usage: /goal <objective>");
      return { handled: true };
    }
    if (!sessionId) {
      ui.setNotice?.("Open a session first.");
      return { handled: true };
    }
    try {
      const r = await cp.client.startSessionGoal(sessionId, args);
      ui.setNotice?.(
        r.running
          ? `Goal started: ${args}`
          : `Goal queued (session busy): ${args}`,
      );
    } catch (err) {
      ui.setNotice?.(`Goal failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }

  // --- /export [md|jsonl] [path]: export transcript; write to workspace + download.
  if (name === "export") {
    if (!sessionId) {
      ui.setNotice?.("Open a session first.");
      return { handled: true };
    }
    const { format, outPath } = parseExportArgs(args);
    try {
      const r = await cp.client.exportSessionTranscript(sessionId, format);
      const dest = outPath ?? r.suggestedName;
      try {
        await cp.client.writeWorkspace(dest, r.body, undefined, undefined, cp.state.cwd || undefined);
        ui.setNotice?.(`Exported ${r.format} → ${dest}`);
      } catch {
        triggerDownload(dest.split(/[/\\]/).pop() || r.suggestedName, r.body);
        ui.setNotice?.(`Exported ${r.format} (download: ${dest})`);
      }
    } catch (err) {
      ui.setNotice?.(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }

  // --- /mode [ask|auto-edit|yolo|auto|dont-ask]: set permission posture.
  if (name === "mode") {
    if (!args) {
      ui.openPanel?.("mode");
      return { handled: true };
    }
    const mode = args.split(/\s+/)[0]!.toLowerCase() as PermissionMode;
    if (!PERMISSION_MODES.has(mode)) {
      ui.setNotice?.(`Unknown mode "${args}". Use: ask | auto-edit | yolo | auto | dont-ask`);
      return { handled: true };
    }
    savePermissionMode(mode);
    if (sessionId) {
      try {
        await cp.client.setPermissionMode(sessionId, mode);
      } catch {
        /* prefs still saved for next session */
      }
    }
    ui.setNotice?.(`Permission mode: ${mode}`);
    return { handled: true };
  }

  // --- /preset [safe|standard|full-access|supervised-auto]
  if (name === "preset") {
    if (!args) {
      ui.openPanel?.("mode");
      ui.setNotice?.(
        `Presets: ${[...PRESET_NAMES].map((n) => `${n} (${PERMISSION_PRESETS[n].description})`).join("; ")}`,
      );
      return { handled: true };
    }
    const preset = args.split(/\s+/)[0]!.toLowerCase() as PermissionPresetName;
    if (!PRESET_NAMES.has(preset)) {
      ui.setNotice?.(`Unknown preset "${args}". Use: ${[...PRESET_NAMES].join(" | ")}`);
      return { handled: true };
    }
    savePermissionMode(PERMISSION_PRESETS[preset].permissionMode);
    if (sessionId) {
      try {
        const out = await cp.client.setPreset(sessionId, preset);
        ui.setNotice?.(`Preset ${out.preset}: ${out.permissionMode} · sandbox ${out.sandbox.mode}`);
        return { handled: true };
      } catch (err) {
        ui.setNotice?.(`Preset failed: ${err instanceof Error ? err.message : String(err)}`);
        return { handled: true };
      }
    }
    ui.setNotice?.(`Preset ${preset} saved for next session`);
    return { handled: true };
  }

  // --- /hooks, /agents: show configured hooks / custom sub-agents as a notice.
  if (name === "hooks") {
    if (!sessionId) {
      ui.setNotice?.("Open a session first.");
      return { handled: true };
    }
    try {
      const r = await cp.client.describeSessionHooks(sessionId);
      ui.setNotice?.(r.text);
    } catch (err) {
      ui.setNotice?.(`Hooks failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }
  if (name === "agents") {
    try {
      const r = await cp.client.describeSessionAgents({
        sessionId: sessionId || undefined,
        cwd: cp.state.cwd || undefined,
      });
      ui.setNotice?.(r.text);
    } catch (err) {
      ui.setNotice?.(`Agents failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { handled: true };
  }

  // --- /theme [name]: apply a named colour palette (client-side).
  if (name === "theme") {
    const raw = args.split(/\s+/)[0]?.toLowerCase();
    if (!raw) {
      ui.setNotice?.(`Themes: ${THEME_NAMES.join(", ")}`);
      return { handled: true };
    }
    if (!(THEME_NAMES as readonly string[]).includes(raw)) {
      ui.setNotice?.(`Unknown theme "${raw}". Use: ${THEME_NAMES.join(" | ")}`);
      return { handled: true };
    }
    applyThemeName(raw as ThemeName, true);
    ui.setNotice?.(`Theme → ${raw}`);
    return { handled: true };
  }

  // --- Panel-opening informational commands (mcp/skills/…):
  //     surface a panel/notice locally; never a prompt.
  if (["mcp", "skills", "context", "plugins", "sessions", "help"].includes(name)) {
    ui.openPanel?.(name);
    return { handled: true };
  }

  // A known LOCAL command this surface doesn't implement (e.g. /vim, /web):
  // surface it as unsupported rather than forwarding — a local action must not
  // turn into a model prompt. Handled locally (no forward).
  if (ui.knownLocalNames?.has(name)) {
    ui.setNotice?.(`/${name} isn't available here yet.`);
    return { handled: true, notice: `/${name} isn't available here yet.` };
  }

  // Unknown command → not a known local action (a project/user/plugin markdown
  // command is prompt-expanding). Let it flow to the server, which resolves it
  // or echoes an "unknown command" hint. The caller forwards the full text.
  return { handled: false };
}
