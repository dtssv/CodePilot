/**
 * Status-line rendering: a declarative `preset` (default/minimal/verbose or a
 * fixed item list) or a custom `command` (TUI spawns per update, feeds session
 * JSON on stdin, renders stdout; ANSI preserved). @module statusLine
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";

/** A snapshot of provider rate-limit state, surfaced into the payload when a
 * recent response carried rate-limit headers. All fields best-effort. */
export interface RateLimitSnapshot {
  /** Requests remaining in the current window, when the provider reports it. */
  requests_remaining?: number;
  /** Tokens remaining in the current window, when reported. */
  tokens_remaining?: number;
  /** Seconds until the limit resets / the server asked us to wait, when known. */
  resets_in_seconds?: number;
}

export interface StatusLinePayload {
  session_id: string;
  session_name?: string;
  transcript_path?: string;
  render_width_chars: number;
  cwd: string;
  model: {
    id: string;
    display_name: string;
    param_summary?: string;
    max_mode?: boolean;
  };
  workspace: {
    current_dir: string;
    project_dir?: string;
    added_dirs: string[];
    /** Current git branch (best-effort; absent outside a repo). */
    git_branch?: string;
  };
  version: string;
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number | null;
    context_window_size: number;
    used_percentage: number | null;
    remaining_percentage: number | null;
  };
  /** Provider rate-limit snapshot — present only when recent headers carried it. */
  rate_limit?: RateLimitSnapshot;
}

/** The declarative items a preset status line can show, in render order. */
export type StatusLineItem =
  | "model"
  | "mode"
  | "context"
  | "branch"
  | "cwd"
  | "session"
  | "rate";

/** Named built-in presets → the item list they render. */
export const STATUS_LINE_PRESETS: Readonly<Record<string, readonly StatusLineItem[]>> = {
  minimal: ["model", "context"],
  default: ["model", "mode", "context", "branch"],
  verbose: ["model", "mode", "context", "branch", "cwd", "rate"],
};

export type StatusLinePresetName = keyof typeof STATUS_LINE_PRESETS;

/** A declarative, built-in status line. Renders in-process from the payload —
 * no subprocess. `preset` picks a named item list; `items` overrides it. */
export interface StatusLinePresetConfig {
  type: "preset";
  /** Named preset; ignored when `items` is given. Default "default". */
  preset?: StatusLinePresetName;
  /** Explicit item list (overrides `preset`). */
  items?: StatusLineItem[];
  padding?: number;
  updateIntervalMs?: number;
}

/** A custom status-line script. The TUI spawns it per update and renders its
 * stdout; the session payload is piped on stdin as JSON. */
export interface StatusLineCommandConfig {
  type: "command";
  command: string;
  padding?: number;
  updateIntervalMs?: number;
  timeoutMs?: number;
}

export type StatusLineConfig = StatusLinePresetConfig | StatusLineCommandConfig;

export interface StatusLineResult {
 /** The raw stdout text (may contain ANSI codes, may be multi-line). */
  text: string;
 /** True if the command exited 0 with non-empty stdout. */
  ok: boolean;
}

/**
 * Run the status-line command with the given payload, returning stdout text and
 * success. Kills the process after `timeoutMs` (default 2000ms) to avoid
 * hanging the UI.
 */
export function runStatusLine(
  config: StatusLineCommandConfig,
  payload: StatusLinePayload,
  opts: { timeoutMs?: number; cwd?: string } = {}
): Promise<StatusLineResult> {
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs ?? 2000;
  const cwd = opts.cwd ?? payload.cwd;
 // Expand ~ in the command path.
  const expanded = config.command.replace(/^~/, homedir());
 // Split into program + args (simple whitespace split; users needing shell
 // features should wrap in a script).
  const parts = expanded.split(/\s+/);
  const program = parts[0];
  const args = parts.slice(1);
  if (!program) {
    return Promise.resolve({ text: "", ok: false });
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(program, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch {
      resolve({ text: "", ok: false });
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ text: stdout, ok });
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", () => { /* discard stderr */ });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && stdout.length > 0));
    child.stdin?.on("error", () => finish(false));

 // Feed the payload on stdin and close it.
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }
  });
}

/** Resolve the item list a preset config renders: explicit `items` win, else
 * the named `preset`, else "default". Unknown names fall back to "default". */
export function resolvePresetItems(config: StatusLinePresetConfig): readonly StatusLineItem[] {
  if (config.items && config.items.length > 0) return config.items;
  return STATUS_LINE_PRESETS[config.preset ?? "default"] ?? STATUS_LINE_PRESETS.default!;
}

/** Render one declarative item from the payload, or null when it has no data
 * (e.g. no git branch, no rate-limit snapshot) so it is omitted cleanly. */
function renderItem(item: StatusLineItem, p: StatusLinePayload): string | null {
  switch (item) {
    case "model":
      return p.model.display_name || p.model.id || null;
    case "mode":
      // Permission/agent mode isn't in the payload; the preset surfaces the
      // param summary when present (e.g. a reasoning setting), else nothing.
      return p.model.param_summary || null;
    case "context": {
      const pct = p.context_window.used_percentage;
      if (pct == null) return null;
      return `ctx ${Math.round(pct)}%`;
    }
    case "branch":
      return p.workspace.git_branch ? `⎇ ${p.workspace.git_branch}` : null;
    case "cwd":
      return basename(p.workspace.current_dir || p.cwd) || null;
    case "session":
      return p.session_id && p.session_id !== "—" ? p.session_id.slice(0, 8) : null;
    case "rate": {
      const r = p.rate_limit;
      if (!r) return null;
      const parts: string[] = [];
      if (r.requests_remaining != null) parts.push(`${r.requests_remaining} req`);
      if (r.tokens_remaining != null) parts.push(`${r.tokens_remaining} tok`);
      if (r.resets_in_seconds != null) parts.push(`${r.resets_in_seconds}s`);
      return parts.length ? parts.join(" ") : null;
    }
    default:
      return null;
  }
}

/**
 * Render a declarative preset status line from the payload — no subprocess.
 * Items with no data are omitted; the rest are joined with " · ". Returns a
 * plain string (no ANSI) the caller renders in its own style.
 */
export function renderPresetStatusLine(
  config: StatusLinePresetConfig,
  payload: StatusLinePayload,
): string {
  const items = resolvePresetItems(config);
  const rendered: string[] = [];
  for (const item of items) {
    const text = renderItem(item, payload);
    if (text) rendered.push(text);
  }
  return rendered.join(" · ");
}

/**
 * Build a `StatusLinePayload` from the session state available to the TUI.
 * Fields that the TUI doesn't track are omitted (absent in the JSON).
 */
export function buildPayload(input: {
  sessionId: string;
  sessionName?: string;
  transcriptPath?: string;
  renderWidth: number;
  cwd: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  contextWindowSize: number;
  usedPercentage: number | null;
  version: string;
  /** Current git branch (best-effort; omit outside a repo). */
  gitBranch?: string;
  /** Latest provider rate-limit snapshot, in the camelCase shape the session
   * captures from provider headers (omit when none captured). */
  rateLimit?: { requestsRemaining?: number; tokensRemaining?: number; resetsInSeconds?: number };
}): StatusLinePayload {
  const remaining = input.usedPercentage != null ? 100 - input.usedPercentage : null;
  // Map the camelCase provider snapshot to the payload's snake_case field;
  // drop it entirely when it carries nothing.
  let rateLimit: RateLimitSnapshot | undefined;
  if (input.rateLimit) {
    const r: RateLimitSnapshot = {};
    if (input.rateLimit.requestsRemaining != null) r.requests_remaining = input.rateLimit.requestsRemaining;
    if (input.rateLimit.tokensRemaining != null) r.tokens_remaining = input.rateLimit.tokensRemaining;
    if (input.rateLimit.resetsInSeconds != null) r.resets_in_seconds = input.rateLimit.resetsInSeconds;
    if (Object.keys(r).length > 0) rateLimit = r;
  }
  return {
    session_id: input.sessionId,
    session_name: input.sessionName,
    transcript_path: input.transcriptPath,
    render_width_chars: input.renderWidth,
    cwd: input.cwd,
    model: {
      id: input.model,
      display_name: input.model,
    },
    workspace: {
      current_dir: input.cwd,
      added_dirs: [],
      ...(input.gitBranch ? { git_branch: input.gitBranch } : {}),
    },
    version: input.version,
    context_window: {
      total_input_tokens: input.totalInputTokens,
      total_output_tokens: input.totalOutputTokens,
      context_window_size: input.contextWindowSize,
      used_percentage: input.usedPercentage,
      remaining_percentage: remaining,
    },
    ...(rateLimit ? { rate_limit: rateLimit } : {}),
  };
}
