#!/usr/bin/env node
/**
 * `codepilot` CLI entry point.
 *
 * Subcommands:
 *   codepilot serve                       — run the JSON-RPC server over stdio.
 *   codepilot run "<task>" [--flags]      — one-shot, non-interactive execution.
 *   codepilot goal "<objective>" [--max-rounds N] — long-horizon goal loop.
 *
 * The CLI talks directly to @codepilot/core (no protocol overhead) for the
 * one-shot paths; only `serve` runs the protocol server.
 */

import {
  runGoal,
  createSession,
  loadConfig,
  type Event,
  type PermissionMode,
  type Session,
} from "@codepilot/core";
import { startServer } from "./server.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function helpText(): string {
  return `codepilot — headless coding agent

Usage:
  codepilot serve
  codepilot run "<task>" [--model M] [--provider P] [--cwd D]
                       [--yolo] [--permission-mode ask|auto-edit|yolo]
                       [--json] [--quiet]
  codepilot goal "<objective>" [--max-rounds N]
  codepilot --help

Environment:
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN — provider keys.
`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  switch (cmd) {
    case "serve":
      return cmdServe();
    case "run":
      return cmdRun(positional.slice(1), flags);
    case "goal":
      return cmdGoal(positional.slice(1), flags);
    default:
      process.stderr.write(`unknown command: ${cmd ?? ""}\n\n${helpText()}`);
      return 2;
  }
}

async function cmdServe(): Promise<number> {
  const handle = await startServer();
  // Wait until stdin closes.
  await handle.peer.loopDone;
  return 0;
}

// ---------- run / goal shared helpers ----------

interface RunFlags {
  model?: string;
  provider?: string;
  cwd?: string;
  permissionMode: PermissionMode;
  json: boolean;
  quiet: boolean;
  yolo: boolean;
}

function resolveRunFlags(flags: Record<string, string | boolean>): RunFlags {
  const mode = (flags["permission-mode"] as PermissionMode | undefined) ?? null;
  const yolo = flags["yolo"] === true || mode === "yolo";
  return {
    model: flags["model"] as string | undefined,
    provider: flags["provider"] as string | undefined,
    cwd: flags["cwd"] as string | undefined,
    permissionMode: yolo ? "yolo" : mode ?? pickDefaultMode(),
    json: flags["json"] === true,
    quiet: flags["quiet"] === true,
    yolo,
  };
}

function pickDefaultMode(): PermissionMode {
  // Non-TTY (pipe / CI / scripted) defaults to auto-edit so single-shot use
  // doesn't deadlock on a permission prompt the user can't see.
  if (!process.stdin.isTTY) return "auto-edit";
  return "ask";
}

function resolveGoalFlags(
  flags: Record<string, string | boolean>,
): RunFlags & { maxRounds?: number } {
  const base = resolveRunFlags(flags);
  const max = flags["max-rounds"];
  const maxRounds = typeof max === "string" ? Number(max) : undefined;
  return { ...base, maxRounds: Number.isFinite(maxRounds) ? maxRounds : undefined };
}

/** Renders an event to stderr in plain text (best-effort). */
function renderEventText(e: Event, stream: NodeJS.WriteStream, skipMessageText = false): void {
  switch (e.type) {
    case "message_delta":
      if (e.delta.type === "text") {
        stream.write(e.delta.text);
      }
      return;
    case "message":
      if (e.role === "assistant" && !skipMessageText) {
        for (const b of e.content) {
          if (b.type === "text") stream.write(b.text);
        }
      }
      return;
    case "tool_call":
      stream.write(`\n[tool:${e.name}] ${safeJson(e.input)}\n`);
      return;
    case "tool_result":
      stream.write(
        `[result${e.isError ? " error" : ""}] ${truncate(e.content, 400)}\n`,
      );
      return;
    case "status":
      stream.write(`\n[status:${e.status}]\n`);
      return;
    case "plan":
      stream.write(
        `\n[plan] ${e.steps
          .map((s) => `${s.id}:${s.status}`)
          .join(", ")}\n`,
      );
      return;
    case "usage":
      stream.write(
        `[usage] in=${e.usage.input} out=${e.usage.output}` +
          (e.usage.costUSD !== undefined ? ` cost=$${e.usage.costUSD.toFixed(4)}` : "") +
          "\n",
      );
      return;
    case "compaction":
      stream.write(`[compaction] ${truncate(e.summary, 200)}\n`);
      return;
    case "error":
      stream.write(`\n[error${e.recoverable ? " recoverable" : ""}] ${e.message}\n`);
      return;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Tracks the last assistant message text. Used to print the final answer on
 * success and as the basis for `--json` consumers that only want the result.
 */
class AssistantBuffer {
  private current: string = "";
  private lastFinal = "";
  reset(): void {
    this.current = "";
  }
  push(text: string): void {
    this.current += text;
  }
  sealFinal(): void {
    if (this.current.length > 0) {
      this.lastFinal = this.current;
      this.current = "";
    }
  }
  snapshot(): string {
    return this.current.length > 0 ? this.current : this.lastFinal;
  }
}

async function cmdRun(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const task = positional.join(" ").trim();
  if (!task) {
    process.stderr.write("run: missing <task>\n");
    return 2;
  }
  const opts = resolveRunFlags(flags);
  const cwd = opts.cwd ?? process.cwd();
  const stderr_ = process.stderr;
  const stdout_ = process.stdout;
  const writer = opts.json ? stdout_ : stderr_;

  let config;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = undefined;
  }
  if (opts.provider) {
    config = { ...(config ?? {}), provider: opts.provider as "anthropic" | "openai" | "copilot" };
  }
  if (opts.model) {
    config = { ...(config ?? {}), model: opts.model };
  }

  const assistantBuf = new AssistantBuffer();
  const session = await createSession({
    cwd,
    config: { ...(config ?? {}), permissionMode: opts.permissionMode },
    model: opts.model,
    onPermissionRequest: async (req) => {
      // Non-interactive fallback (the spec: "需要 ask 时自动 deny 并在输出中说明").
      const note = `permission denied (non-interactive): ${req.toolName} — ${req.reason}\n`;
      if (opts.json) {
        writer.write(JSON.stringify({ type: "permission_denied", ...req }) + "\n");
      } else if (!opts.quiet) {
        stderr_.write("\n" + note);
      }
      // If --yolo, honor it (we kept the mode='yolo' flag separately).
      if (opts.yolo) return "allow";
      return "deny";
    },
  });

  if (!opts.quiet && !opts.json) {
    stderr_.write(`[codepilot] session=${session.id} cwd=${cwd} mode=${opts.permissionMode}\n`);
  }

  // Subscribe BEFORE prompt() so events aren't missed. Session.subscribe replays
  // history (per core contract); we ignore history by only keeping events that
  // arrive after subscription. Implementation detail: we read the head offset.
  let history = 0;
  try {
    history = session.getEvents().length;
  } catch {
    history = 0;
  }
  // Message ids whose text already arrived via deltas — the final `message`
  // event for these must not be rendered/buffered again (would duplicate text).
  const streamedIds = new Set<string>();
  const unsub = session.subscribe((e) => {
    if (history > 0) {
      history--;
      return;
    }
    if (e.type === "message_delta") streamedIds.add(e.messageId);
    const alreadyStreamed = e.type === "message" && streamedIds.has(e.id);
    if (opts.json) {
      // NDJSON event stream.
      writer.write(JSON.stringify(e) + "\n");
      return;
    }
    if (!opts.quiet) renderEventText(e, writer, alreadyStreamed);
    if (e.type === "message_delta" && e.delta.type === "text") {
      assistantBuf.push(e.delta.text);
    } else if (e.type === "message" && e.role === "assistant") {
      if (!alreadyStreamed) {
        for (const b of e.content) {
          if (b.type === "text") assistantBuf.push(b.text);
        }
      }
      assistantBuf.sealFinal();
    }
  });

  let exitCode = 0;
  try {
    await session.prompt(task);
    // After prompt completes, mark the buffered text as the final answer.
    assistantBuf.sealFinal();
  } catch (err) {
    exitCode = 1;
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      stdout_.write(JSON.stringify({ type: "error", message: msg }) + "\n");
    } else {
      stderr_.write(`\n[codepilot] error: ${msg}\n`);
    }
  } finally {
    unsub();
    try {
      await session.dispose();
    } catch {
      /* ignore */
    }
  }

  // Final assistant text → stdout on success, regardless of --json (json users
  // already got deltas; we still emit a trailing summary line for convenience).
  const finalText = assistantBuf.snapshot().trim();
  if (finalText.length > 0) {
    if (opts.json) {
      stdout_.write(JSON.stringify({ type: "result", text: finalText }) + "\n");
    } else {
      // Make sure the final newline is on its own line in non-json mode.
      stderr_.write("\n");
    }
  }
  return exitCode;
}

async function cmdGoal(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const objective = positional.join(" ").trim();
  if (!objective) {
    process.stderr.write("goal: missing <objective>\n");
    return 2;
  }
  const opts = resolveGoalFlags(flags);
  const cwd = opts.cwd ?? process.cwd();
  const stderr_ = process.stderr;
  const stdout_ = process.stdout;
  const writer = opts.json ? stdout_ : stderr_;

  let config;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = undefined;
  }
  if (opts.provider) {
    config = { ...(config ?? {}), provider: opts.provider as "anthropic" | "openai" | "copilot" };
  }
  if (opts.model) {
    config = { ...(config ?? {}), model: opts.model };
  }

  const onPermissionRequest = async (req: {
    toolName: string;
    reason: string;
    input: unknown;
    requestId: string;
  }) => {
    const note = `permission denied (non-interactive): ${req.toolName} — ${req.reason}\n`;
    if (opts.json) {
      writer.write(JSON.stringify({ type: "permission_denied", ...req }) + "\n");
    } else if (!opts.quiet) {
      stderr_.write("\n" + note);
    }
    if (opts.yolo) return "allow" as const;
    return "deny" as const;
  };

  const onRound = opts.json
    ? (round: number, status: string) => {
        stdout_.write(JSON.stringify({ type: "round", round, status }) + "\n");
      }
    : (round: number, status: string) => {
        stderr_.write(`[round ${round}] ${status}\n`);
      };

  let session: Session | undefined;
  try {
    const result = await runGoal({
      cwd,
      config,
      objective,
      maxRounds: opts.maxRounds,
      onRound,
      onPermissionRequest,
    });
    if (opts.json) {
      stdout_.write(JSON.stringify({ type: "result", ...result }) + "\n");
    } else {
      stderr_.write(`[goal] ${result.status}${result.reason ? `: ${result.reason}` : ""}\n`);
    }
    return result.status === "completed" ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      stdout_.write(JSON.stringify({ type: "error", message: msg }) + "\n");
    } else {
      stderr_.write(`[goal] error: ${msg}\n`);
    }
    return 1;
  } finally {
    if (session) {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `codepilot: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);