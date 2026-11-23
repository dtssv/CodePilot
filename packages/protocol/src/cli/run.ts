import {
  runGoal,
  createSession,
  killAllJobs,
  loadConfig,
  listSelectableModels,
  resolveModelTarget,
  applyProviderAndModel,
  useProvider,
  runHeadless,
  parseOutputFormat,
  type OutputFormat,
  type AgentMode,
  type Event,
  type PermissionMode,
  type PermissionDecision,
  type Session,
} from "@codepilot/core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { detectWebRoot } from "../agent-app.js";
import { PrettyRenderer, prettyOutput } from "../cli-render.js";
import { startWebSocketServer } from "../ws.js";
import { describe } from "./args.js";

export async function cmdAgent(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const cwd = resolve(positional[0] ?? (typeof flags["cwd"] === "string" ? flags["cwd"] : process.cwd()));
  if (!existsSync(cwd)) {
    process.stderr.write(`agent: no such directory: ${cwd}\n`);
    return 2;
  }
  const webRoot = typeof flags["web-root"] === "string" ? flags["web-root"] : detectWebRoot("agent");
  if (!webRoot) return 2;
  const portFlag = flags["port"];
  const port = typeof portFlag === "string" ? Number(portFlag) : 0;
  if (!Number.isInteger(port)) {
    process.stderr.write(`invalid --port: ${String(portFlag)}\n`);
    return 2;
  }

  const { agentPageUrl, openAgentWindow } = await import("../agent-app.js");
  const handle = await startWebSocketServer({ port, host: "127.0.0.1", staticRoot: webRoot, defaultCwd: cwd });
  const url = agentPageUrl(handle.host, handle.port, handle.token, cwd);

  let closed: Promise<void> = new Promise(() => {});
  if (flags["no-open"] === true) {
    process.stdout.write(`${url}\n`);
  } else {
    const win = openAgentWindow(url);
    closed = win.closed;
    process.stderr.write(
      win.kind === "app"
        ? `[agent] opened in ${win.browser} — close the window to stop\n`
        : `[agent] opened in your browser — press Ctrl+C to stop\n[agent] ${url}\n`,
    );
  }
  process.stderr.write(`[agent] working in ${cwd}\n`);

  await new Promise<void>((done) => {
    const stop = (): void => {
      void handle.close().then(done, () => done());
    };
    void closed.then(stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
interface RunFlags {
  model?: string;
  provider?: string;
  cwd?: string;
  permissionMode: PermissionMode;
  /** Machine-readable output format; undefined means human text to stderr. */
  format?: OutputFormat;
  /** Cap on agent turns for this run (maps to config.maxTurns). */
  maxTurns?: number;
  quiet: boolean;
  yolo: boolean;
}

function resolveRunFlags(flags: Record<string, string | boolean>): RunFlags {
  const mode = (flags["permission-mode"] as PermissionMode | undefined) ?? null;
  const yolo = flags["yolo"] === true || mode === "yolo";
  // Output format: explicit `--output-format text|json|stream-json`, or the
  // legacy boolean `--json` alias (a raw event NDJSON stream historically) which
  // now maps to `stream-json` — the same per-event NDJSON plus a closing result.
  let format: OutputFormat | undefined;
  const rawFormat = flags["output-format"];
  if (typeof rawFormat === "string") {
    format = parseOutputFormat(rawFormat);
  } else if (flags["json"] === true) {
    format = "stream-json";
  }
  const rawMaxTurns = flags["max-turns"];
  const maxTurns = typeof rawMaxTurns === "string" ? Number(rawMaxTurns) : undefined;
  return {
    model: flags["model"] as string | undefined,
    provider: flags["provider"] as string | undefined,
    cwd: flags["cwd"] as string | undefined,
    permissionMode: yolo ? "yolo" : mode ?? pickDefaultMode(),
    format,
    maxTurns: Number.isFinite(maxTurns) && (maxTurns as number) >= 0 ? maxTurns : undefined,
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
): RunFlags & { maxRounds?: number; maxStalls?: number } {
  const base = resolveRunFlags(flags);
  const max = flags["max-rounds"];
  const maxRounds = typeof max === "string" ? Number(max) : undefined;
  const stalls = flags["max-stalls"];
  const maxStalls = typeof stalls === "string" ? Number(stalls) : undefined;
  return {
    ...base,
    maxRounds: Number.isFinite(maxRounds) ? maxRounds : undefined,
    maxStalls: Number.isFinite(maxStalls) ? maxStalls : undefined,
  };
}

const prettyRenderers = new WeakMap<NodeJS.WriteStream, PrettyRenderer>();

/** Renders an event to stderr: styled on a terminal, plain text otherwise. */
function renderEventText(e: Event, stream: NodeJS.WriteStream, skipMessageText = false): void {
  if (prettyOutput(stream)) {
    let r = prettyRenderers.get(stream);
    if (!r) prettyRenderers.set(stream, (r = new PrettyRenderer(stream)));
    r.render(e);
    return;
  }
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
      stream.write(`[${e.kind === "micro-fold" ? "archived" : "compaction"}] ${truncate(e.summary, 200)}\n`);
      return;
    case "error":
      stream.write(`\n[error${e.recoverable ? " recoverable" : ""}] ${e.message}\n`);
      return;
    case "retry":
      stream.write(
        `\n[retry ${e.attempt}/${e.maxAttempts}] ${truncate(e.reason, 160)} — retrying in ${Math.round(e.delayMs / 1000)}s\n`,
      );
      return;
    case "team_message":
      stream.write(
        `[team:${e.kind ?? "msg"}] ${e.from} → ${e.to}: ${truncate(e.content, 300)}\n`,
      );
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

/** The REPL's own command set — this surface runs the headless engine without
 * pickers, so it lists only what the switch below actually dispatches. */
export function headlessHelpText(): string {
  return [
    "Commands — optional arguments are shown in [ ].",
    "",
    "  /model                    list selectable models for this provider",
    "  /model <name>             switch model on the current provider",
    "  /model <provider>/<model> switch model, any configured provider",
    "  /provider <id>            switch provider preset",
    "  /mode <chat|plan|agent>   set collaboration mode",
    "       chat   read-only Q&A; no edits, no shell",
    "       plan   read-only, then the model produces a plan",
    "       agent  full autonomy (default)",
    "  /clear                    clear the screen (transcript is kept)",
    "  /help                     show this help (also /?)",
    "  /exit                     exit (also /quit, Ctrl+D)",
    "",
    "Anything not starting with / is sent to the model as a prompt.",
    "",
  ].join("\n");
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

export async function cmdRun(
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
  const machine = opts.format !== undefined;
  const allowedTools =
    typeof flags["allowed-tools"] === "string"
      ? (flags["allowed-tools"] as string).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  let config;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = undefined;
  }
 // `--provider` may be a base type (anthropic/openai/copilot) OR a named
 // preset id from config.providers (e.g. "custom-openai"). A preset must be
 // expanded into provider/apiKey/baseURL, else the engine falls back to the
 // Anthropic default and fails with "missing API key".
  const presets = (config as { providers?: Record<string, unknown> } | undefined)?.providers ?? {};
  if (opts.provider && opts.provider in presets) {
    config = useProvider(config ?? {}, opts.provider);
  } else if (opts.provider) {
    config = { ...(config ?? {}), provider: opts.provider as "anthropic" | "openai" | "copilot" };
  }
  if (opts.model) {
    const target = resolveModelTarget(config ?? {}, opts.model);
    const applied = applyProviderAndModel(config ?? {}, target.providerId, opts.model);
    config = applied.config;
  }

  const assistantBuf = new AssistantBuffer();
  const session = await createSession({
    cwd,
    config: {
      ...(config ?? {}),
      permissionMode: opts.permissionMode,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    },
    model: opts.model,
    onPermissionRequest: async (req) => {
 // Non-interactive fallback: when a tool needs approval we can't get, deny
 // and note it. Machine formats keep stdout clean for the contract, so the
 // note goes to stderr there too.
      const note = `permission denied (non-interactive): ${req.toolName} — ${req.reason}\n`;
      if (!opts.quiet) stderr_.write("\n" + note);
 // If --yolo, honor it (we kept the mode='yolo' flag separately).
      if (opts.yolo) return "allow";
      return "deny";
    },
  });

  if (!opts.quiet && !machine) {
    stderr_.write(`[codepilot] session=${session.id} cwd=${cwd} mode=${opts.permissionMode}\n`);
  }

  // Machine formats (text / json / stream-json) use the shared headless
  // contract so this entry point's output matches every other non-interactive
  // surface byte-for-byte. The legacy boolean `--json` is an alias for
  // stream-json (see resolveRunFlags).
  if (machine) {
    let result;
    try {
      result = await runHeadless({
        session,
        prompt: task,
        format: opts.format!,
        allowedTools,
        write: (line) => void stdout_.write(line),
      });
    } finally {
      try {
        await session.dispose();
      } catch {
        /* ignore */
      }
      await killAllJobs().catch(() => {});
    }
    return result.subtype === "error" ? 1 : 0;
  }

 // Human text path: render events to stderr, keeping stdout clean.
 // Subscribe BEFORE prompt so events aren't missed. Session.subscribe replays
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
    if (!opts.quiet) renderEventText(e, stderr_, alreadyStreamed);
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
    stderr_.write(`\n[codepilot] error: ${msg}\n`);
  } finally {
    unsub();
    try {
      await session.dispose();
    } catch {
 /* ignore */
    }
    await killAllJobs().catch(() => {});
  }

 // Trailing newline so the final answer sits on its own line.
  if (assistantBuf.snapshot().trim().length > 0) stderr_.write("\n");
  return exitCode;
}

export async function cmdGoal(
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
  // The goal command emits its own round-event NDJSON when any machine format
  // is requested (`--json` or `--output-format json|stream-json`).
  const json = opts.format !== undefined;
  const writer = json ? stdout_ : stderr_;

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
    if (json) {
      writer.write(JSON.stringify({ type: "permission_denied", ...req }) + "\n");
    } else if (!opts.quiet) {
      stderr_.write("\n" + note);
    }
    if (opts.yolo) return "allow" as const;
    return "deny" as const;
  };

  const onRound = json
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
      maxStalls: opts.maxStalls,
      onRound,
      onPermissionRequest,
    });
    if (json) {
      stdout_.write(JSON.stringify({ type: "result", ...result }) + "\n");
    } else {
      stderr_.write(`[goal] ${result.status}${result.reason ? `: ${result.reason}` : ""}\n`);
    }
    return result.status === "completed" ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
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

// ---------- interactive REPL ----------

/**
 * `codepilot` / `codepilot chat` / `codepilot repl`: multi-turn interactive
 * conversation over stdio (readline + the `run` event renderer). Slash
 * commands: /mode, /model, /clear, /help, /exit. Ctrl+D exits.
 */
export async function cmdRepl(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const cwd = (flags["cwd"] as string | undefined) ?? process.cwd();
  const stderr_ = process.stderr;

 // If a `serve` is already running locally, attach to it as a client so this
 // terminal follows the SAME live sessions the web/other clients drive —
 // rather than starting a second, independent in-process engine (which is why
 // "cli doesn't update while web runs" happened). `--local` forces the old
 // standalone engine; `--no-attach` is a synonym.
  const forceLocal = flags["local"] === true || flags["no-attach"] === true;
  if (!forceLocal && positional.length === 0) {
    try {
      const { readLiveServeInfo } = await import("../serve-info.js");
      const info = await readLiveServeInfo();
      if (info) {
        const { cmdConnect } = await import("../cli-connect.js");
        const following = typeof flags["session"] === "string" || flags["attach"] === true;
        stderr_.write(
          following
            ? `[chat] found a running serve at ${info.url} — following an existing session. Pass --local for a separate engine.\n`
            : `[chat] found a running serve at ${info.url} — starting a new session on it (use --session <id> or --attach to follow an existing one; --local for a separate engine).\n`,
        );
        return cmdConnect({
          url: info.url,
          token: info.token || undefined,
          sessionId: flags["session"] as string | undefined,
          fresh: flags["new"] === true,
          attachNewest: flags["attach"] === true,
          cwd,
        });
      }
    } catch {
 /* fall through to in-process engine */
    }
  }

  let config;
  try {
    config = await loadConfig(cwd);
  } catch {
    config = undefined;
  }
  if (flags["provider"]) {
    config = { ...(config ?? {}), provider: flags["provider"] as "anthropic" | "openai" | "copilot" };
  }
  const flagModel = flags["model"] as string | undefined;
  if (flagModel) config = { ...(config ?? {}), model: flagModel };

 // Interactive mode: prefer an explicit --permission-mode / --yolo, else the
 // project/user config's permissionMode, else "ask" so writes still need
 // approval on a fresh install.
  const mode = (flags["permission-mode"] as PermissionMode | undefined) ?? null;
  const yolo = flags["yolo"] === true || mode === "yolo";
  const permissionMode: PermissionMode = yolo
    ? "yolo"
    : mode ?? config?.permissionMode ?? "ask";

 // An initial prompt passed as a positional arg (e.g. `codepilot chat "hi"`)
 // is sent on the first turn, then we drop into the read loop.
  const initialPrompt = positional.join(" ").trim() || undefined;

  const session = await createSession({
    cwd,
    config: { ...(config ?? {}), permissionMode },
    model: flagModel,
    onPermissionRequest: async (req) => {
 // Interactive: prompt on stderr and read a yes/no/always answer. The
 // main readline interface is paused while a prompt runs, so we use a
 // throwaway interface on the same stdin.
      stderr_.write(
        `\n[permission] ${req.toolName} — ${req.reason}\n` +
          `  input: ${truncate(safeJson(req.input), 200)}\n` +
          `  allow once (y), always this session (a), deny (n)? `,
      );
      const prl = readline.createInterface({ input: process.stdin, output: process.stderr });
      let decision: PermissionDecision = "deny";
      try {
        const ans = await new Promise<string>((resolve) => {
          prl.question("", (answer) => resolve(answer));
        });
        const a = ans.trim().toLowerCase();
        if (a.startsWith("a")) decision = "always";
        else if (a.startsWith("y") || a === "") decision = "allow";
      } catch {
        decision = "deny";
      } finally {
        prl.close();
      }
      stderr_.write("\n");
      return decision;
    },
  });

  stderr_.write(
    `[codepilot] session=${session.id} cwd=${cwd} mode=${permissionMode}\n` +
      `Type a message and press Enter. /help for commands, Ctrl+C to cancel a turn, Ctrl+D to exit.\n`,
  );

 // Stream session events to the terminal as they arrive.
  const renderedMsgIds = new Set<string>();
  const assistantBuf = new AssistantBuffer();
  let history = 0;
  try {
    history = session.getEvents().length;
  } catch {
    history = 0;
  }
  const unsub = session.subscribe((e) => {
    if (history > 0) {
      history--;
      return;
    }
    if (e.type === "message_delta") renderedMsgIds.add(e.messageId);
    const alreadyStreamed = e.type === "message" && renderedMsgIds.has(e.id);
    renderEventText(e, stderr_, alreadyStreamed);
    if (e.type === "message_delta" && e.delta.type === "text") assistantBuf.push(e.delta.text);
    else if (e.type === "message" && e.role === "assistant" && !alreadyStreamed) {
      for (const b of e.content) if (b.type === "text") assistantBuf.push(b.text);
      assistantBuf.sealFinal();
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "› ",
    history: [],
    terminal: process.stderr.isTTY,
  });

  let busy = false;

  const setBusy = (b: boolean): void => {
    busy = b;
    if (b) rl.pause();
    else rl.resume();
  };

  const sendPrompt = async (text: string): Promise<void> => {
    setBusy(true);
    assistantBuf.reset();
    try {
      await session.prompt(text);
      assistantBuf.sealFinal();
    } catch (err) {
      stderr_.write(`\n[codepilot] error: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      setBusy(false);
      stderr_.write("\n");
      rl.prompt();
    }
  };

  const handleLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line.length === 0) {
      rl.prompt();
      return;
    }
 // Pause input while handling so piped/typed lines don't race the async
 // work below; resumed by the prompt at each exit point.
    rl.pause();
    try {
      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        switch (cmd) {
          case "exit":
          case "quit":
            rl.close();
            return;
          case "help":
          case "?":
            stderr_.write(headlessHelpText());
            break;
          case "mode": {
            const m = arg as AgentMode;
            if (m === "chat" || m === "plan" || m === "agent") {
              try {
                await session.setAgentMode(m);
                stderr_.write(`[mode] ${m}\n`);
              } catch (err) {
                stderr_.write(`[mode] failed: ${describe(err)}\n`);
              }
            } else {
              stderr_.write("[mode] usage: /mode <chat|plan|agent>\n");
            }
            break;
          }
          case "model": {
            if (!arg) {
              const models = listSelectableModels(session.getConfig());
              if (models.length === 0) {
                stderr_.write("[model] no selectable models — configure providers in ~/.codepilot/config.json\n");
              } else {
                for (const m of models.filter((x) => x.kind === "chat")) {
                  const mark =
                    m.model === session.getModel() &&
                    (session.getProviderId() === undefined || m.providerId === session.getProviderId())
                      ? "*"
                      : " ";
                  stderr_.write(`${mark} ${m.id}\t${m.providerLabel}\n`);
                }
              }
              break;
            }
            try {
              const resolved = resolveModelTarget(session.getConfig(), arg);
              await session.setModel(resolved.model, resolved.providerId);
              const pid = session.getProviderId();
              stderr_.write(`[model] ${pid ? `${pid}/` : ""}${session.getModel()}\n`);
            } catch (err) {
              stderr_.write(`[model] failed: ${describe(err)}\n`);
            }
            break;
          }
          case "provider": {
            if (!arg) {
              stderr_.write("[provider] usage: /provider <id>\n");
              break;
            }
            try {
              await session.setProvider(arg);
              stderr_.write(`[provider] ${session.getProviderId() ?? arg} · ${session.getModel()}\n`);
            } catch (err) {
              stderr_.write(`[provider] failed: ${describe(err)}\n`);
            }
            break;
          }
          case "clear": {
 // Clear the visible terminal; the transcript in core is untouched.
            stderr_.write("\x1B[2J\x1B[H");
            break;
          }
          default:
            stderr_.write(`Unknown command: /${cmd}. Try /help.\n`);
            break;
        }
        rl.resume();
        rl.prompt();
        return;
      }
 // Real prompt: resume is handled in sendPrompt's finally.
      rl.resume();
      await sendPrompt(line);
    } catch (err) {
      stderr_.write(`[codepilot] error: ${describe(err)}\n`);
      rl.resume();
      rl.prompt();
    }
  };

  let currentLine: Promise<void> = Promise.resolve();
  rl.on("line", (raw) => {
 // Chain lines so they run serially; track the tail so close can wait.
    currentLine = currentLine.then(() => handleLine(raw), () => handleLine(raw));
  });
  rl.on("close", () => {
 /* closing the interface resolves the await below and exits */
  });
 // Ctrl+C (SIGINT): cancel the current turn if busy, else exit. readline
 // emits SIGINT rather than closing on Ctrl+C by default.
  rl.on("SIGINT", () => {
    if (busy) {
      try {
        session.cancel();
        stderr_.write("\n[cancelling…]\n");
      } catch {
 /* ignore */
      }
    } else {
      rl.close();
    }
  });

  rl.prompt();

 // Fire the initial prompt, if any, then wait for the REPL to close.
  if (initialPrompt) {
    void sendPrompt(initialPrompt);
  }

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });
 // Wait for any in-flight line handler to finish before tearing down, so
 // an async slash command (e.g. /mode) piped right before EOF still gets
 // to print its result.
  await currentLine.catch(() => {});

  unsub();
  try {
    await session.dispose();
  } catch {
 /* ignore */
  }
  // Process exit (not turn cancel): stop background servers started this run.
  await killAllJobs().catch(() => {});
  return 0;
}
