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
import { createPermissionBridge } from "./ui/controller.js";
import { createMockSession } from "./dev/mockSession.js";

type ParsedArgs = {
  cwd: string;
  model?: string;
  provider?: "anthropic" | "openai" | "copilot";
  yolo: boolean;
  resume?: string;
  mock: boolean;
  prompt?: string;
  showHelp: boolean;
};

const HELP = `codepilot-tui — interactive terminal UI for CodePilot

Usage:
  codepilot-tui [options] [prompt...]

Options:
  --cwd <dir>        Project directory (default: $PWD)
  --model <name>     Override model (e.g. claude-sonnet-4-5)
  --provider <p>     One of anthropic|openai|copilot
  --yolo             Start in yolo permission mode (auto-approve all)
  --resume <id>      Resume an existing session
  --mock             Use an in-memory mock session (no core needed; for UI dev)
  -h, --help         Show this help

If positional arguments are provided, they are joined and submitted as the
first prompt once the UI is ready.
`;

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
      case a === "--yolo": {
        out.yolo = true;
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
  let model: string | undefined = args.model;
  const bridge = createPermissionBridge();

  if (!args.mock) {
    core = await tryLoadCore();
  }

  if (core === null) {
    // Dev fallback — never blocks UI work while core is being implemented.
    const mock = createMockSession({
      cwd: args.cwd,
      yolo: args.yolo,
      bridge,
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
    };
    permissionMode = config.permissionMode ?? "ask";
    model = config.model;

    session = await core.createSession({
      cwd: args.cwd,
      config,
      sessionId: args.resume,
      model: args.model,
      onPermissionRequest: (req) => bridge.waitDecision(req),
    });
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
      cwd: args.cwd,
      model,
      permissionMode,
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