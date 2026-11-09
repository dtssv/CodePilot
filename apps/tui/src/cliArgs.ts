/**
 * Pure argv parsing for the TUI entry — no UI or protocol imports, so it loads
 * (and unit-tests) in a plain Node environment without pulling React / Ink /
 * CodeMirror or the protocol CLI graph.
 */
import { resolve } from "node:path";

export const AGENT_MODES = ["chat", "plan", "agent"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Words that, when they appear as the first argv token, select a subcommand. */
export const SUBCOMMANDS = ["bundle"] as const;

/** First-token command words handled by the protocol CLI, not the TUI. The
 * unified binary routes these to `runProtocolCli`; a bare invocation (or any
 * other first token) opens the interactive TUI. */
export const CLI_COMMANDS = new Set([
  "web",
  "serve",
  "run",
  "goal",
  "agent",
  "config",
  "export",
  "update",
  "connect",
]);

export type ParsedArgs = {
  cwd: string;
  model?: string;
  provider?: "anthropic" | "openai" | "copilot";
  yolo: boolean;
  resume?: string;
  mock: boolean;
  /** Force the in-process engine even when a `serve` is running locally.
   * Default behaviour attaches to a live serve so the TUI follows the same
   * session the web/other clients drive. */
  local: boolean;
  /** When attaching to a live serve without --resume, follow the server's
   * NEWEST session instead of opening a fresh one. Opt-in. */
  attach: boolean;
  prompt?: string;
  showHelp: boolean;
  /** Collaboration mode. */
  mode?: AgentMode;
  /** Headless / print mode. When true, skip the Ink UI
   * and run a single prompt to completion, writing to stdout. */
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

/**
 * Minimal hand-rolled argv parser (avoids an extra runtime dep).
 * Supports `--flag value`, `--flag=value`, boolean `--flag`, and bare positionals.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    cwd: process.cwd(),
    yolo: false,
    mock: false,
    local: false,
    attach: false,
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
      case a === "--local" || a === "--no-attach": {
        out.local = true;
        break;
      }
      case a === "--attach": {
        out.attach = true;
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
      `--config-patch is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "--config-patch must be a JSON object (e.g. '{\"model\":\"gpt-4o\"}')",
    );
  }
  return parsed as Record<string, unknown>;
}
