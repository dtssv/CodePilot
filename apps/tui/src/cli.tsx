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

export type ParsedArgs = {
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
  /** Restrict which tools the agent can use (comma-separated tool names). */
  allowedTools?: string[];
  /** Maximum number of agent turns. */
  maxTurns?: number;
  /** Activate a named config profile (merged on top of the base config). */
  profile?: string;
  /** Raw JSON merge-patch string (--config-patch '{"model":"gpt-4o"}'). */
  configPatch?: string;
  /** Subcommand ("bundle") when argv[0] is a known subcommand word. */
  subcommand?: string;
  /** Remaining positional args after the subcommand word. */
  subcommandArgs: string[];
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

  Config composition:
  --profile <name>           Activate a named profile from the config's
                             "profiles" map. The profile is merged on top of
                             the base config (equivalent to setting
                             "activeProfile" or CODEPILOT_PROFILE).
  --config-patch '<json>'    Apply a JSON merge-patch on top of the final
                             resolved config. Objects merge recursively,
                             scalars/arrays replace, null deletes a key.
                             Example:
                               --config-patch '{"model":"gpt-4o","permissionMode":"yolo"}'

Subcommands:
  bundle export [path]       Export the resolved config + custom commands,
                             agents and skills to a single JSON bundle file
                             (default path: ./codepilot-bundle.json).
  bundle import <path>       Import a bundle: writes the config to
                             ~/.codepilot/config.json and the resources to
                             ~/.codepilot/{commands,agents,skills}/.

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
  --allowed-tools <t1,t2>    Restrict which tools the agent can use
                              (comma-separated, e.g. bash,read_file,write_file)
  --max-turns <N>            Maximum number of agent turns (default: 50)

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

/** Words that, when they appear as the first argv token, select a subcommand. */
const SUBCOMMANDS = ["bundle"] as const;

/**
 * Minimal hand-rolled argv parser (avoids an extra runtime dep).
 * Supports `--flag value`, `--flag=value`, boolean `--flag`, and bare positionals.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    cwd: process.cwd(),
    yolo: false,
    mock: false,
    showHelp: false,
    print: false,
    subcommandArgs: [],
  };
  // Subcommand detection: `codepilot bundle export ./x.json`. The subcommand
  // word and everything after it are captured separately and NOT parsed as
  // flags (a bundle path may legitimately start with "-" in exotic cases).
  if (
    argv.length > 0 &&
    !argv[0]!.startsWith("-") &&
    (SUBCOMMANDS as readonly string[]).includes(argv[0]!)
  ) {
    out.subcommand = argv[0];
    // Split subcommand args into positionals (kept verbatim) and recognised
    // global flags (--profile, --config-patch) that may appear after them.
    const positional: string[] = [];
    const rest = argv.slice(1);
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j]!;
      if (a === "--profile" || a.startsWith("--profile=")) {
        const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++j];
        if (v) out.profile = v;
      } else if (a === "--config-patch" || a.startsWith("--config-patch=")) {
        const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++j];
        if (v) out.configPatch = v;
      } else {
        positional.push(a);
      }
    }
    out.subcommandArgs = positional;
    return out;
  }
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
      case a === "--allowed-tools":
      case a.startsWith("--allowed-tools="): {
        const v = takeValue();
        if (v) {
          out.allowedTools = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        }
        break;
      }
      case a === "--max-turns":
      case a.startsWith("--max-turns="): {
        const v = takeValue();
        if (v) {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            out.maxTurns = n;
          } else {
            process.stderr.write(
              `codepilot-tui: --max-turns must be a positive integer (got: ${v})\n`,
            );
            process.exit(2);
          }
        }
        break;
      }
      case a === "--profile":
      case a.startsWith("--profile="): {
        const v = takeValue();
        if (v) out.profile = v;
        break;
      }
      case a === "--config-patch":
      case a.startsWith("--config-patch="): {
        const v = takeValue();
        if (v === undefined) {
          process.stderr.write(
            "codepilot-tui: --config-patch requires a JSON argument (e.g. --config-patch '{\"model\":\"gpt-4o\"}')\n",
          );
          process.exit(2);
        }
        out.configPatch = v;
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
 * Parse the `--config-patch '<json>'` value into an object. Throws a
 * user-friendly error when the JSON is malformed or not an object.
 */
export function parseConfigPatch(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--config-patch is not valid JSON: ${(err as Error).message}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "--config-patch must be a JSON object (e.g. '{\"model\":\"gpt-4o\"}')"
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * `codepilot bundle export [path]` / `codepilot bundle import <path>`.
 * Returns the process exit code (0 on success).
 */
export async function runBundle(
  subcommandArgs: readonly string[],
  globals: ParsedArgs
): Promise<number> {
  const core = await tryLoadCore();
  if (core === null) {
    process.stderr.write(
      "codepilot-tui: bundle requires @codepilot/core (build packages/core first)\n"
    );
    return 1;
  }
  const [action, ...rest] = subcommandArgs;
  switch (action) {
    case "export": {
      const target = resolve(rest[0] ?? "codepilot-bundle.json");
      try {
        const patch = globals.configPatch
          ? parseConfigPatch(globals.configPatch)
          : undefined;
        const bundle = await core.exportBundleToFile(target, {
          cwd: globals.cwd,
          profile: globals.profile,
          patch,
        });
        const counts =
          `${Object.keys(bundle.commands).length} commands, ` +
          `${Object.keys(bundle.agents).length} agents, ` +
          `${Object.keys(bundle.skills).length} skills`;
        process.stdout.write(`Exported bundle to ${target} (${counts})\n`);
        return 0;
      } catch (err) {
        process.stderr.write(
          `codepilot-tui: bundle export failed: ${(err as Error).message}\n`
        );
        return 1;
      }
    }
    case "import": {
      const source = rest[0];
      if (!source) {
        process.stderr.write(
          "codepilot-tui: bundle import requires a path (codepilot bundle import <path>)\n"
        );
        return 2;
      }
      try {
        const result = await core.importBundleFromFile(resolve(source));
        process.stdout.write(
          `Imported bundle: config -> ${result.configPath}, ` +
            `${result.commands} commands, ${result.agents} agents, ` +
            `${result.skills} skills\n`
        );
        return 0;
      } catch (err) {
        process.stderr.write(
          `codepilot-tui: bundle import failed: ${(err as Error).message}\n`
        );
        return 1;
      }
    }
    default:
      process.stderr.write(
        `codepilot-tui: unknown bundle action "${action ?? ""}" ` +
          "(expected: export [path] | import <path>)\n"
      );
      return 2;
  }
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

  // Subcommands short-circuit before any session/UI setup.
  if (args.subcommand === "bundle") {
    process.exit(await runBundle(args.subcommandArgs, args));
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
    // Resolve the layered config, then apply the --profile composition and
    // the --config-patch JSON merge-patch on top of it.
    let patch: Record<string, unknown> | undefined;
    if (args.configPatch !== undefined) {
      try {
        patch = parseConfigPatch(args.configPatch);
      } catch (err) {
        process.stderr.write(`codepilot-tui: ${(err as Error).message}\n`);
        process.exit(2);
      }
    }
    const cfg = await core.loadConfigWithSources(args.cwd, undefined, {
      profile: args.profile,
      patch,
    }).then((r) => r.config).catch((err: unknown) => {
      process.stderr.write(`codepilot-tui: ${(err as Error).message}\n`);
      process.exit(2);
    });
    const config: import("@codepilot/core").CodepilotConfig = {
      ...cfg,
      permissionMode: args.yolo ? "yolo" : (cfg.permissionMode ?? "ask"),
      provider: args.provider ?? cfg.provider,
      model: args.model ?? cfg.model,
      agentMode: args.mode ?? cfg.agentMode,
      maxTurns: args.maxTurns ?? cfg.maxTurns,
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
      await runHeadless({
        session,
        prompt,
        format,
        maxTurns: args.maxTurns,
        allowedTools: args.allowedTools,
      });
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
