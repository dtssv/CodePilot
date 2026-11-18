#!/usr/bin/env node
/**
 * `codepilot` CLI entry point. Subcommands: serve, run, goal, agent.
 * One-shot paths talk directly to @codepilot/core; only `serve` runs the
 * JSON-RPC protocol server.
 */

import { startSelfUpdateWatcher } from "@codepilot/core";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, helpText } from "./cli/args.js";
import { cmdConfig } from "./cli/config.js";
import { cmdServe, cmdServeWeb } from "./cli/serve.js";
import { cmdRun, cmdGoal, cmdRepl, cmdAgent } from "./cli/run.js";
import { cmdUpdate, cmdExport, cmdAcp } from "./cli/update.js";

export async function runProtocolCli(rawArgv?: readonly string[]): Promise<number> {
  const argv = rawArgv ? [...rawArgv] : process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  const skipUpdate =
    argv.includes("--no-update") ||
    process.env.CODEPILOT_SKIP_UPDATE === "1" ||
    process.env.CODEPILOT_NO_UPDATE === "1";
  // Background update watcher: once at startup, then every 24h while alive.
  // Skipped for explicit `update` (handled below) and when disabled.
  if (!skipUpdate && argv[0] !== "update") {
    startSelfUpdateWatcher();
  }
  if (argv.length === 0) {
 // No args in a TTY → interactive REPL. Non-TTY (pipe/CI) → help.
    if (process.stdin.isTTY) return cmdRepl([], {});
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0];

  switch (cmd) {
    case "serve":
      return cmdServe(flags);
    case "acp":
      return cmdAcp(flags);
    case "web":
      // Open the web UI: serve the embedded SPA over the protocol on one
      // loopback port and open the browser (unless --no-open). Honours
      // --port / --host / --token like `serve --web`.
      return cmdServeWeb({ ...flags, web: true, "web-root": true });
    case "run":
      return cmdRun(positional.slice(1), flags);
    case "goal":
      return cmdGoal(positional.slice(1), flags);
    case "agent":
      return cmdAgent(positional.slice(1), flags);
    case "config":
      return cmdConfig(positional.slice(1), flags);
    case "export":
      return cmdExport(positional.slice(1), flags);
    case "update":
      return cmdUpdate(flags);
    case "chat":
    case "repl":
      return cmdRepl(positional.slice(1), flags);
    case "connect": {
      const { cmdConnect } = await import("./cli-connect.js");
      return cmdConnect({
        url: (flags["connect"] as string) || (flags["url"] as string) || (positional[1] ?? "127.0.0.1:18765"),
        token: flags["token"] as string | undefined,
        sessionId: flags["session"] as string | undefined,
        fresh: flags["new"] === true,
 // `codepilot connect` is an explicit "go follow the session" command,
 // so default to the newest session unless --new or a --session id.
        attachNewest: flags["new"] !== true,
        cwd: flags["cwd"] as string | undefined,
      });
    }
    default:
 // Unknown command — if it looks like a flags-only invocation
 // (e.g. `codepilot --cwd .`), enter REPL.
      if (Object.keys(flags).length > 0 && positional.length === 0) {
        return cmdRepl([], flags);
      }
      process.stderr.write(`unknown command: ${cmd ?? ""}\n\n${helpText()}`);
      return 2;
  }
}

// Run only when invoked directly as the entry point; when imported (e.g. by the
// unified binary's TUI entry) this module exposes `runProtocolCli` without
// self-executing. In a Bun-compiled binary every module shares one
// `import.meta.url`, so the unified entry sets `__CODEPILOT_UNIFIED__` first to
// suppress this self-exec; the standalone protocol binary leaves it unset.
function isDirectEntry(): boolean {
  if ((globalThis as { __CODEPILOT_UNIFIED__?: boolean }).__CODEPILOT_UNIFIED__) {
    return false;
  }
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? resolve(process.argv[1]) : "";
    return entry === self;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  runProtocolCli().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `codepilot: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}