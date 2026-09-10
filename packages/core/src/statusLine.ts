/**
 * Custom status-line script runner (claude-code-style).
 *
 * When `config.statusLine` is set, the TUI spawns the configured command on
 * each status update, feeds it a JSON payload on stdin describing the
 * session, and renders the command's stdout as the status line. This lets
 * users customise the status bar with arbitrary scripts (git branch, context
 * usage bar, custom colors, etc.) without touching the TUI source.
 *
 * The command is spawned with `child_process.spawn` (no shell on Unix).
 * Updates are debounced at the configured interval. If a new update arrives
 * while a script is running, the in-flight process is killed and the new
 * invocation starts immediately. ANSI color codes in stdout are preserved.
 *
 * @module statusLine
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";

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
  };
  version: string;
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number | null;
    context_window_size: number;
    used_percentage: number | null;
    remaining_percentage: number | null;
  };
}

export interface StatusLineConfig {
  type: "command";
  command: string;
  padding?: number;
  updateIntervalMs?: number;
  timeoutMs?: number;
}

export interface StatusLineResult {
  /** The raw stdout text (may contain ANSI codes, may be multi-line). */
  text: string;
  /** True if the command exited 0 with non-empty stdout. */
  ok: boolean;
}

/**
 * Run the status-line command with the given payload. Returns the stdout
 * text and whether the command succeeded. Kills the process after
 * `timeoutMs` (default 2000ms) to avoid hanging the UI.
 *
 * This is a synchronous-from-the-caller-perspective async function — it
 * resolves once the command finishes or times out.
 */
export function runStatusLine(
  config: StatusLineConfig,
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
}): StatusLinePayload {
  const remaining = input.usedPercentage != null ? 100 - input.usedPercentage : null;
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
    },
    version: input.version,
    context_window: {
      total_input_tokens: input.totalInputTokens,
      total_output_tokens: input.totalOutputTokens,
      context_window_size: input.contextWindowSize,
      used_percentage: input.usedPercentage,
      remaining_percentage: remaining,
    },
  };
}
