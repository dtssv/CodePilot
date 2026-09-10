#!/usr/bin/env node
/**
 * CodePilot TUI — CLI entry.
 *
 * Parses argv, loads core config, creates a session, and mounts the Ink TUI.
 * If a positional prompt is given, it's submitted once the UI is ready.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import React from "react";

import { App as AppUI } from "./ui/App.js";
import { createPermissionBridge, createQuestionBridge } from "./ui/controller.js";
import { createMockSession } from "./dev/mockSession.js";
import { runHeadless, parseOutputFormat } from "./headless.js";

const AGENT_MODES = ["chat", "plan", "agent"] as const;
type AgentMode = (typeof AGENT_MODES)[number];

type ParsedArgs = {
  cwd: string;
  model?: string;
  provider?: "anthropic" | "openai" | "copilot";
  yolo: boolean;
  resume?: string;
  mock: boolean;
  prompt?: string;
  showHelp: boolean;
  /** Cursor-style collaboration mode. */
  mode?: AgentMode;
  /** Headless / print mode (claude-code `-p`). When true, skip the Ink UI
   *  and run a single prompt to completion, writing to stdout. */
  print: boolean;
  /** Output format for print mode (text | json | stream-json). */
  outputFormat?: string;
};

const HELP = `codepilot-tui — interactive terminal UI for CodePilot

Usage:
  codepilot-tui [options] [prompt...]

Options:
  --cwd <dir>                Project directory (default: $PWD)
  --model <name>             Override model (e.g. claude-sonnet-4-5)
  --provider <p>             One of anthropic|openai|copilot
  --yolo                     Start in yolo permission mode (auto-approve all)
  --mode <chat|plan|agent>   Start in a Cursor-style collaboration mode
                               chat  — read-only Q&A (no edits, no shell)
                               plan  — read-only + plan_update; produces a plan
                               agent — full autonomy (default)
  --resume <id>              Resume an existing session
  --mock                     Use an in-memory mock session (no core needed; for UI dev)

  Headless / print mode (claude-code -p equivalent — for scripts & CI):
  -p, --print                Run a single prompt to completion and exit.
                             No interactive UI. Requires a prompt (positional
                             args or piped via stdin). Implies --yolo unless a
                             permission mode is set, since there's no UI to
                             approve tool calls interactively.
  --output-format <fmt>      Print-mode output: text | json | stream-json
                               text        — final assistant text only (default)
                               json        — single result JSON object
                               stream-json — NDJSON, one event per line (realtime)

  -h, --help                 Show this help

If positional arguments are provided, they are joined and submitted as the
first prompt once the UI is ready (or as the sole prompt in --print mode).
`;

/**
 * Read all of stdin as a string. Resolves to "" when stdin is a TTY (no
 * piped input). Used by --print mode to accept prompts piped via stdin:
 *   echo "review this" | codepilot-tui -p --output-format json
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // When stdin is a TTY (no pipe), resolve immediately with "" so the
    // caller can fall back to a positional prompt or error out.
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    // Safety: if nothing ever ends the stream, resolve after 10s so we
    // don't hang forever in CI environments that don't close stdin.
    setTimeout(() => resolve(data), 10_000).unref?.();
  });
}

/**
 * Minimal hand-rolled argv parser (avoids an extra runtime dep).
 * Supports `--flag value`, `--flag=value`, boolean `--flag`, and bare positionals.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    cwd: process.cwd(),
    yolo: false,
    mock: false,
    showHelp: false,
    print: false,
  };
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.showHelp = true;
      i++;
      continue;
    }
    const eq = a.indexOf("=");
    const takeValue = (): string | undefined => {
      if (eq >= 0) return a.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      i++;
      return next;
    };
    switch (true) {
      case a === "--cwd":
      case a.startsWith("--cwd="): {
        const v = takeValue();
        if (v) out.cwd = resolve(v);
        break;
      }
      case a === "--model":
      case a.startsWith("--model="): {
        const v = takeValue();
        if (v) out.model = v;
        break;
      }
      case a === "--provider":
      case a.startsWith("--provider="): {
        const v = takeValue();
        if (v === "anthropic" || v === "openai" || v === "copilot") {
          out.provider = v;
        }
        break;
      }
      case a === "--resume":
      case a.startsWith("--resume="): {
        const v = takeValue();
        if (v) out.resume = v;
        break;
      }
      case a === "--mode":
      case a.startsWith("--mode="): {
        const v = takeValue();
        if (v && (AGENT_MODES as readonly string[]).includes(v)) {
          out.mode = v as AgentMode;
        } else if (v !== undefined) {
          process.stderr.write(
            `codepilot-tui: --mode must be one of ${AGENT_MODES.join(", ")} (got: ${v})\n`,
          );
          process.exit(2);
        }
        break;
      }
      case a === "--yolo": {
        out.yolo = true;
        break;
      }
      case a === "-p" || a === "--print" || a.startsWith("--print="): {
        const v = takeValue();
        // --print is a boolean flag; --print=false explicitly disables.
        out.print = v === undefined ? true : v !== "false" && v !== "0";
        break;
      }
      case a === "--output-format":
      case a.startsWith("--output-format="): {
        const v = takeValue();
        if (v) out.outputFormat = v;
        break;
      }
      case a === "--mock": {
        out.mock = true;
        break;
      }
      case a.startsWith("--"): {
        // Unknown flag — ignore gracefully.
        break;
      }
      default:
        positional.push(a);
    }
    i++;
  }
  if (positional.length > 0) out.prompt = positional.join(" ");
  return out;
}

/**
 * Try to dynamically import @codepilot/core. Returns null if the package
 * isn't built/linked (so we can fall back to the mock session during UI dev).
 */
async function tryLoadCore(): Promise<typeof import("@codepilot/core") | null> {
  try {
    // Dynamic import resolves through node_modules; the TUI's node_modules
    // contains the workspace link to packages/core/dist/index.js once built.
    const mod = await import("@codepilot/core");
    return mod;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    process.stdout.write(HELP);
    return;
  }

  if (!existsSync(args.cwd)) {
    process.stderr.write(`codepilot-tui: --cwd not found: ${args.cwd}\n`);
    process.exit(2);
  }

  // Build a core session. In mock mode (or when core isn't installed yet),
  // fall back to an in-memory mock so the UI is still exercisable.
  let session: import("@codepilot/core").Session;
  let core: typeof import("@codepilot/core") | null = null;
  let permissionMode: import("@codepilot/core").PermissionMode = args.yolo
    ? "yolo"
    : "ask";
  let agentMode: import("@codepilot/core").AgentMode = args.mode ?? "agent";
  let model: string | undefined = args.model;
  const bridge = createPermissionBridge();
  const questionBridge = createQuestionBridge();

  if (!args.mock) {
    core = await tryLoadCore();
  }

  if (core === null) {
    // Dev fallback — never blocks UI work while core is being implemented.
    const mock = createMockSession({
      cwd: args.cwd,
      yolo: args.yolo,
      bridge,
      questionBridge,
      initialAgentMode: agentMode,
    });
    session = mock.session;
    permissionMode = args.yolo ? "yolo" : "ask";
    model = model ?? mock.defaultModel;
  } else {
    const cfg = await core.loadConfig(args.cwd);
    const config: import("@codepilot/core").CodepilotConfig = {
      ...cfg,
      permissionMode: args.yolo ? "yolo" : (cfg.permissionMode ?? "ask"),
      provider: args.provider ?? cfg.provider,
      model: args.model ?? cfg.model,
      agentMode: args.mode ?? cfg.agentMode,
    };
    permissionMode = config.permissionMode ?? "ask";
    agentMode = config.agentMode ?? "agent";
    model = config.model;

    session = await core.createSession({
      cwd: args.cwd,
      config,
      sessionId: args.resume,
      model: args.model,
      agentMode,
      onPermissionRequest: (req) => bridge.waitDecision(req),
      onAskUser: (req) => questionBridge.waitAnswers(req),
      onMcpOpenAuthUrl: (server, url) => {
        // Surface the authorization URL: print to stderr (so it's visible
        // even while the TUI owns stdout) and attempt to open it in the
        // browser. The core handles the local redirect listener + token
        // exchange; we just need to get the user to visit the URL.
        process.stderr.write(
          `\n[mcp:${server}] Authorization required.\nOpen this URL in your browser to authorize:\n${url}\n\n`,
        );
        // Best-effort browser open (non-blocking, ignored on failure).
        import("node:child_process")
          .then(({ exec }) => {
            const cmd =
              process.platform === "darwin"
                ? `open "${url}"`
                : process.platform === "win32"
                  ? `start "" "${url}"`
                  : `xdg-open "${url}"`;
            exec(cmd, () => undefined);
          })
          .catch(() => undefined);
      },
    });
    // Reflect the actual current mode (e.g. resumed sessions may differ).
    agentMode = session.getAgentMode();
  }

  // ---- Headless / print mode ----
  // When --print is set, skip the Ink UI entirely: read the prompt (from
  // args or stdin), run it to completion, write output to stdout, exit.
  // There's no interactive permission UI in this mode, so we require a
  // non-interactive permission mode (yolo) — otherwise tool calls that
  // need approval are denied (the bridge has no resolver attached).
  if (args.print) {
    let prompt = args.prompt;
    if (prompt === undefined || prompt.trim() === "") {
      // Read the prompt from stdin if nothing was passed positionally.
      // Supports both piped input (`echo "x" | codepilot-tui -p`) and
      // interactive typing (rare in print mode, but supported).
      const stdinText = await readStdin();
      prompt = stdinText.trim();
    }
    if (prompt.length === 0) {
      process.stderr.write(
        "codepilot-tui: --print requires a prompt (pass positional args or pipe via stdin)\n",
      );
      try { await session.dispose(); } catch { /* ignore */ }
      process.exit(2);
    }

    let format: "text" | "json" | "stream-json";
    try {
      format = parseOutputFormat(args.outputFormat);
    } catch (err) {
      process.stderr.write(`codepilot-tui: ${(err as Error).message}\n`);
      try { await session.dispose(); } catch { /* ignore */ }
      process.exit(2);
    }

    // In print mode there's no UI to resolve permission requests or ask
    // questions. We don't attach handlers, so the session falls back to
    // its permissionMode: yolo auto-approves everything; ask/auto-edit
    // deny any tool call that would normally prompt. The user gets a
    // clear result object either way.
    try {
      await runHeadless({ session, prompt, format });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (format === "text") {
        process.stderr.write(`codepilot-tui: ${msg}\n`);
      } else {
        // Emit a result object with subtype "error" so JSON consumers
        // always get a parseable final line.
        process.stdout.write(
          JSON.stringify({
            type: "result",
            subtype: "error",
            result: msg,
            session_id: session.id,
            usage: session.getUsage(),
            duration_ms: 0,
            num_turns: 0,
            had_tool_calls: false,
            errors: [msg],
          }) + "\n",
        );
      }
      try { await session.dispose(); } catch { /* ignore */ }
      process.exit(1);
    }
    try { await session.dispose(); } catch { /* ignore */ }
    process.exit(0);
  }

  // We need a way for the UI to (a) trigger runGoal and (b) list sessions,
  // and to (c) override the model/mode at runtime via slash commands. The
  // simplest approach: expose a tiny mutable "controller" object that the
  // TUI can call into. For the mock case we wire it to no-ops or in-memory
  // equivalents.
  const controller: import("./ui/controller.js").SessionController =
    core === null
      ? {
          kind: "mock",
          listSessions: async () => [],
          runGoal: async () => ({ status: "blocked", reason: "mock mode" }),
        }
      : {
          kind: "core",
          core,
          cwd: args.cwd,
          resumeId: args.resume,
        };

  const instance = render(
    React.createElement(AppUI, {
      session,
      controller,
      permissionBridge: bridge,
      questionBridge,
      cwd: args.cwd,
      model,
      permissionMode,
      initialAgentMode: agentMode,
      initialPrompt: args.prompt,
    }),
  );

  // Graceful shutdown: dispose session and unmount Ink on signals.
  const cleanup = async (): Promise<void> => {
    instance.unmount();
    try {
      await session.dispose();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  await instance.waitUntilExit();
  try {
    await session.dispose();
  } catch {
    /* ignore */
  }
}

// Run. Top-level await keeps the entry simple and lets async errors surface.
const __filename = fileURLToPath(import.meta.url);
const __entry =
  process.argv[1] !== undefined
    ? resolve(process.argv[1])
    : resolve(__filename);
if (__entry === __filename) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`codepilot-tui: ${msg}\n`);
    process.exit(1);
  });
}
