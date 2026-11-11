#!/usr/bin/env node
/**
 * CodePilot TUI — CLI entry.
 *
 * Parses argv, loads core config, creates a session, and mounts the Ink TUI.
 * If a positional prompt is given, it's submitted once the UI is ready.
 */
// Must be the first import: sets the unified-binary marker before the protocol
// CLI module evaluates, so its self-exec guard stays off in this binary.
import "./unifiedMarker.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import React from "react";

import { App as AppUI } from "./ui/App.js";
import { createGoalBridge, createPermissionBridge, createQuestionBridge } from "./ui/controller.js";
import { createMockSession } from "./dev/mockSession.js";
import { runHeadless, parseOutputFormat } from "./headless.js";
import { runProtocolCli } from "@codepilot/protocol/cli";
import {
  CLI_COMMANDS,
  type ParsedArgs,
  parseArgs,
  parseConfigPatch,
} from "./cliArgs.js";

export { type ParsedArgs, parseArgs, parseConfigPatch };

const HELP = `codepilot-tui — interactive terminal UI for CodePilot

Usage:
  codepilot-tui [options] [prompt...]

Options:
  --cwd <dir>                Project directory (default: $PWD)
  --model <name>             Override model (e.g. claude-sonnet-4-5)
  --provider <p>             One of anthropic|openai|copilot
  --yolo                     Start in yolo permission mode (auto-approve all)
  --mode <chat|plan|agent>   Start in a Collaboration mode
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

  Headless / print mode (for scripts & CI):
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
 * echo "review this" | codepilot-tui -p --output-format json
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

/** Fixed port the shared daemon binds (and clients discover via serve.json). */
const SHARED_DAEMON_PORT = 18765;

/**
 * Resolve how to spawn the shared daemon from THIS runtime:
 * - Unified binary: re-exec ourselves (`<self> serve --daemon`); the command
 *   router dispatches `serve` to the protocol CLI.
 * - Source / npm (node + cli.js): run the protocol CLI entry directly so we do
 *   not depend on the TUI's own argv routing.
 */
function resolveDaemonLaunch(cwd: string): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const base = ["serve", "--daemon", "--port", String(SHARED_DAEMON_PORT)];
  const env: NodeJS.ProcessEnv = { ...process.env, CODEPILOT_CLIENT: "tui" };
  const unified = (globalThis as { __CODEPILOT_UNIFIED__?: boolean }).__CODEPILOT_UNIFIED__ === true;
  const isBunCompiled = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (unified && isBunCompiled) {
    return { command: process.execPath, args: base, env };
  }
  // Source/npm: resolve the protocol CLI entry and run it under node.
  try {
    const cliEntry = resolve(
      fileURLToPath(new URL("../../..", import.meta.url)),
      "packages",
      "protocol",
      "dist",
      "cli.js",
    );
    if (existsSync(cliEntry)) return { command: process.execPath, args: [cliEntry, ...base], env };
  } catch {
    /* fall through */
  }
  // Last resort: re-exec the current entry (works when argv[1] is the cli).
  const entry = process.argv[1];
  return entry
    ? { command: process.execPath, args: [entry, ...base], env }
    : { command: process.execPath, args: base, env };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  // Route protocol CLI commands (web / serve / run / …) to the protocol CLI so
  // a single binary serves both the interactive TUI and the command surface.
  if (rawArgv.length > 0 && CLI_COMMANDS.has(rawArgv[0]!)) {
    process.exit(await runProtocolCli(rawArgv));
  }

  const args = parseArgs(rawArgv);
  if (args.showHelp) {
    process.stdout.write(HELP);
    return;
  }

 // Subcommands short-circuit before any session/UI setup.
  if (args.subcommand === "bundle") {
    process.exit(await runBundle(args.subcommandArgs, args));
  }

  // In-place update check (startup + daily). No-op outside ~/.codepilot installs.
  if (
    process.env.CODEPILOT_SKIP_UPDATE !== "1" &&
    process.env.CODEPILOT_NO_UPDATE !== "1" &&
    !process.argv.includes("--no-update")
  ) {
    try {
      const { startSelfUpdateWatcher } = await import("@codepilot/core");
      startSelfUpdateWatcher();
    } catch {
      /* optional */
    }
  }

  if (!existsSync(args.cwd)) {
    process.stderr.write(`codepilot-tui: --cwd not found: ${args.cwd}\n`);
    process.exit(2);
  }

 // Build a core session. In mock mode (or when core isn't installed yet),
 // fall back to an in-memory mock so the UI is still exercisable.
  let session!: import("@codepilot/core").Session;
  let core: typeof import("@codepilot/core") | null = null;
  let permissionMode: import("@codepilot/core").PermissionMode = args.yolo
    ? "yolo"
    : "ask";
  let agentMode: import("@codepilot/core").AgentMode = args.mode ?? "agent";
  let model: string | undefined = args.model;
  const bridge = createPermissionBridge();
  const questionBridge = createQuestionBridge();
  const goalBridge = createGoalBridge();

 // Attach to the shared `serve` daemon so every client (desktop, web, IDE,
 // terminal) drives ONE local server. If none is running, the terminal spawns
 // the shared daemon itself and then connects — so whoever starts first owns
 // the server and the rest attach to it. `--local` forces a standalone
 // in-process engine instead. Skipped for --mock and --print (print wants a
 // self-contained one-shot run).
  let attached = false;
  // How the UI reached its engine, for the welcome header. Left undefined for
  // mock/print; set to "local" when the shared daemon was unreachable or
  // `--local` forced a standalone engine.
  let connection: import("./ui/App.js").ConnectionInfo | undefined;
  let currentRemote: import("./remoteSession.js").RemoteSession | null = null;
  if (!args.mock && !args.local && !args.print) {
    try {
      const { discoverOrSpawnDaemon } = await import("@codepilot/protocol");
      const launch = resolveDaemonLaunch(args.cwd);
      const { info } = await discoverOrSpawnDaemon({
        command: launch.command,
        args: launch.args,
        cwd: args.cwd,
        env: launch.env,
      });
      if (info) {
        const { RemoteSession } = await import("./remoteSession.js");
        const remote = await RemoteSession.connect({
          url: info.url,
          token: info.token || undefined,
          cwd: args.cwd,
          sessionId: args.resume,
          attachNewest: args.attach,
          agentMode,
          onPermissionRequest: (req) => bridge.waitDecision(req),
          onAskUser: (req) => questionBridge.waitAnswers(req),
          onPromptResolved: (kind, requestId) =>
            kind === "permission" ? bridge.dismiss(requestId) : questionBridge.dismiss(requestId),
        });
        session = remote as unknown as import("@codepilot/core").Session;
        currentRemote = remote;
        agentMode = remote.getAgentMode();
        model = remote.getModel() || model;
        attached = true;
        connection = {
          mode: args.resume ? "following" : args.attach ? "following" : "shared",
          sessionId: remote.id,
        };
      }
    } catch {
      // The shared serve was unreachable; fall through to a local in-process
      // engine. The welcome header reflects the local mode instead.
    }
  }

  if (!args.mock && !attached) {
    core = await tryLoadCore();
    // Not on the shared daemon — a standalone in-process engine drives this UI.
    if (!args.print) connection = { mode: "local" };
  }

  if (attached) {
 // `session` is already the RemoteSession — nothing to build locally.
  } else if (core === null) {
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
      onGoalRequest: (req) => goalBridge.request(session.id, req),
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
    const headlessStartedAt = Date.now();
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
            duration_ms: Date.now() - headlessStartedAt,
            // num_turns / had_tool_calls are tallied inside runHeadless and are
            // not recoverable once it throws; report conservative placeholders.
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
  const remoteForController = currentRemote as import("./remoteSession.js").RemoteSession | null;
  const controller: import("./ui/controller.js").SessionController = remoteForController
    ? (() => {
        let remote = remoteForController;
        return {
          kind: "remote" as const,
          cwd: args.cwd,
          listSessions: () => remote.listSessions(),
          openSession: async (id: string) => {
            remote = await remote.reopen(id);
            return remote as unknown as import("@codepilot/core").Session;
          },
        };
      })()
    : core === null
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
      goalBridge,
      cwd: args.cwd,
      model,
      permissionMode,
      initialAgentMode: agentMode,
      initialPrompt: args.prompt,
      connection,
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
    const debug = process.env.CODEPILOT_LOG_LEVEL === "debug";
    const msg = err instanceof Error ? (debug ? (err.stack ?? err.message) : err.message) : String(err);
    process.stderr.write(`codepilot-tui: ${msg}\n`);
    if (err instanceof Error && !debug) {
      process.stderr.write("(set CODEPILOT_LOG_LEVEL=debug for details)\n");
    }
    process.exit(1);
  });
}
