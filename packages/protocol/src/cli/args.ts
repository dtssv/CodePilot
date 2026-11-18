import { resolve } from "node:path";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
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

export function helpText(): string {
  return `codepilot — headless coding agent

Usage:
  codepilot [interactive]              — interactive REPL (default when TTY)
  codepilot connect [HOST:PORT] [--token T] [--session ID] [--new]
                                       — attach the terminal to a RUNNING
                                         \`serve\` and follow a live session in
                                         real time (same session the web UI
                                         drives; default 127.0.0.1:18765)
  codepilot web [--port N] [--host H]  — open the web UI (serves the embedded
                       [--token T] [--no-open]  SPA and opens the browser)
  codepilot serve                      — JSON-RPC over stdio
  codepilot acp [--cwd D]              — Agent Client Protocol (ACP) over stdio,
                                         for ACP-capable editors/tools (opt-in)
  codepilot serve --web [--port N] [--host H] [--token T]
                       [--allow-origin O1,O2] [--no-auth] [--web-root [DIR]]
                       [--no-open]
                                         — WebSocket protocol (default port
                                           18765); with --web-root hosts the SPA
                                           and opens the browser with token
  codepilot serve --daemon [--port N]  — shared local daemon (same as --web
                                         --no-open); writes ~/.codepilot/serve.json
                                         (+ server.json); exits after last client
                                         + 30s idle grace
  codepilot run "<task>" [--model M] [--provider P] [--cwd D]
                       [--yolo] [--permission-mode ask|auto-edit|yolo|auto|dont-ask]
                       [--output-format text|json|stream-json] [--allowed-tools a,b]
                       [--max-turns N] [--json] [--quiet]
                                         — --output-format selects machine output:
                                           json = one result object; stream-json =
                                           per-event NDJSON + closing result; text =
                                           final answer only. --json is an alias for
                                           --output-format stream-json. Without a
                                           format, human text goes to stderr.
  codepilot goal "<objective>" [--max-rounds N] [--max-stalls N]
  codepilot agent [DIR] [--port N] [--no-open]
                                         — the agent app: task-oriented UI for
                                           working in DIR (default: cwd), opened
                                           in a Chrome/Edge app window
  codepilot config show|providers|add|remove|use|templates
                                         — manage ~/.codepilot/config.json providers
  codepilot export [session-id] [--format md|jsonl] [-o PATH]
                                         — export a session transcript (default: newest)
  codepilot update [--check]             — in-place update from GitHub Releases
                                         (or only check with --check)
  codepilot --help

Interactive mode (REPL):
  Just run \`codepilot\` in a TTY to enter a multi-turn conversation.
  Slash commands: /mode <chat|plan|agent>, /model [/provider], /provider <id>,
  /clear, /exit, /help
  Up/Down arrows recall history; Ctrl+C cancels the current turn.

serve --web notes:
  Binds 127.0.0.1 and requires a token (auto-generated, printed on start).
  Browser clients must also come from an allowed Origin — localhost on the
  same port is allowed by default; add others with --allow-origin.
  This port fronts an agent that can run shell commands: do not expose it.

Environment:
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN — provider keys.
`;
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}