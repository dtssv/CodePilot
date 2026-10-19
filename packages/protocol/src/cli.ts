#!/usr/bin/env node
/**
 * `codepilot` CLI entry point.
 *
 * Subcommands:
 * codepilot serve — run the JSON-RPC server over stdio.
 * codepilot run "<task>" [--flags] — one-shot, non-interactive execution.
 * codepilot goal "<objective>" [--max-rounds N] — long-horizon goal loop.
 * codepilot agent [dir] — the agent app (web UI in an app window).
 *
 * The CLI talks directly to @codepilot/core (no protocol overhead) for the
 * one-shot paths; only `serve` runs the protocol server.
 */

import {
  runGoal,
  createSession,
  loadConfig,
  loadConfigWithSources,
  listSelectableModels,
  resolveModelTarget,
  applyProviderAndModel,
  useProvider,
  upsertUserProvider,
  deleteUserProvider,
  setUserActiveEndpoint,
  templateToPreset,
  PROVIDER_TEMPLATES,
  redactApiKey,
  type AgentMode,
  type Event,
  type PermissionMode,
  type PermissionDecision,
  type ProviderPreset,
  type ResolvedCodepilotConfig,
  type Session,
} from "@codepilot/core";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { PrettyRenderer, prettyOutput } from "./cli-render.js";
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
  codepilot [interactive]              — interactive REPL (default when TTY)
  codepilot connect [HOST:PORT] [--token T] [--session ID] [--new]
                                       — attach the terminal to a RUNNING
                                         \`serve\` and follow a live session in
                                         real time (same session the web UI
                                         drives; default 127.0.0.1:18765)
  codepilot serve                      — JSON-RPC over stdio
  codepilot serve --web [--port N] [--host H] [--token T]
                       [--allow-origin O1,O2] [--no-auth] [--web-root [DIR]]
                       [--no-open]
                                         — WebSocket protocol (default port
                                           18765); with --web-root hosts the SPA
                                           and opens the browser with token
  codepilot run "<task>" [--model M] [--provider P] [--cwd D]
                       [--yolo] [--permission-mode ask|auto-edit|yolo]
                       [--json] [--quiet]
  codepilot goal "<objective>" [--max-rounds N]
  codepilot agent [DIR] [--port N] [--no-open]
                                         — the agent app: task-oriented UI for
                                           working in DIR (default: cwd), opened
                                           in a Chrome/Edge app window
  codepilot config show|providers|add|remove|use|templates
                                         — manage ~/.codepilot/config.json providers
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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText() + "\n");
    return 0;
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
    case "run":
      return cmdRun(positional.slice(1), flags);
    case "goal":
      return cmdGoal(positional.slice(1), flags);
    case "agent":
      return cmdAgent(positional.slice(1), flags);
    case "config":
      return cmdConfig(positional.slice(1), flags);
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

function configHelp(): string {
  return `codepilot config — manage user providers (~/.codepilot/config.json)

Usage:
  codepilot config show
  codepilot config providers
  codepilot config templates
  codepilot config add <id> --provider openai|anthropic|copilot
                          [--base-url URL] [--api-key KEY] [--model M]
                          [--small-model M] [--models m1,m2] [--display-name N]
                          [--from-template TEMPLATE_ID] [--use]
  codepilot config remove <id>
  codepilot config use <id> [--model M]
`;
}

async function cmdConfig(
  positional: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const sub = positional[0] ?? "show";
  const cwd = typeof flags["cwd"] === "string" ? resolve(flags["cwd"]) : process.cwd();

  switch (sub) {
    case "help":
    case "--help":
      process.stdout.write(configHelp() + "\n");
      return 0;
    case "show": {
      const { config, sources } = await loadConfigWithSources(cwd);
      const { hasApiKey, apiKeyHint } = redactApiKey(config.apiKey);
      const out = {
        active: {
          provider: config.provider,
          model: config.model,
          smallModel: config.smallModel,
          baseURL: config.baseURL,
          hasApiKey,
          apiKeyHint,
          activeProvider: (config as ResolvedCodepilotConfig & { activeProvider?: string })
            .activeProvider,
        },
        providers: Object.fromEntries(
          Object.entries(config.providers ?? {}).map(([id, p]) => {
            const red = redactApiKey(p.apiKey);
            return [
              id,
              {
                ...p,
                apiKey: undefined,
                hasApiKey: red.hasApiKey,
                apiKeyHint: red.apiKeyHint,
              },
            ];
          }),
        ),
        selectableModels: listSelectableModels(config),
        sources: sources.map((s) => ({ name: s.name, source: s.source })),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return 0;
    }
    case "providers": {
      const { config } = await loadConfigWithSources(cwd);
      const providers = config.providers ?? {};
      if (Object.keys(providers).length === 0) {
        process.stdout.write("(no providers configured — try `codepilot config templates`)\n");
        return 0;
      }
      for (const [id, p] of Object.entries(providers)) {
        const red = redactApiKey(p.apiKey);
        const key = red.hasApiKey ? ` key=···${red.apiKeyHint}` : " key=-";
        process.stdout.write(
          `${id}\t${p.provider}\t${p.displayName ?? ""}\tmodel=${p.model ?? "-"}${key}` +
            (p.baseURL ? `\t${p.baseURL}` : "") +
            "\n",
        );
      }
      return 0;
    }
    case "templates": {
      for (const t of PROVIDER_TEMPLATES) {
        process.stdout.write(
          `${t.id}\t${t.displayName}\t${t.provider}` +
            (t.baseURL ? `\t${t.baseURL}` : "") +
            (t.models?.length ? `\t[${t.models.join(", ")}]` : "") +
            (t.description ? `\t${t.description}` : "") +
            "\n",
        );
      }
      return 0;
    }
    case "add": {
      const id = positional[1];
      if (!id) {
        process.stderr.write("usage: codepilot config add <id> [...flags]\n");
        return 2;
      }
      let preset: ProviderPreset;
      const fromTemplate =
        typeof flags["from-template"] === "string" ? flags["from-template"] : undefined;
      if (fromTemplate) {
        const tmpl = PROVIDER_TEMPLATES.find((t) => t.id === fromTemplate);
        if (!tmpl) {
          process.stderr.write(`unknown template: ${fromTemplate}\n`);
          return 2;
        }
        preset = templateToPreset(tmpl);
      } else {
        const provider = flags["provider"];
        if (provider !== "openai" && provider !== "anthropic" && provider !== "copilot") {
          process.stderr.write(
            "config add requires --provider openai|anthropic|copilot (or --from-template)\n",
          );
          return 2;
        }
        preset = { provider };
      }
      if (typeof flags["base-url"] === "string") preset.baseURL = flags["base-url"];
      if (typeof flags["api-key"] === "string") preset.apiKey = flags["api-key"];
      if (typeof flags["model"] === "string") preset.model = flags["model"];
      if (typeof flags["small-model"] === "string") preset.smallModel = flags["small-model"];
      if (typeof flags["display-name"] === "string") preset.displayName = flags["display-name"];
      if (typeof flags["models"] === "string") {
        preset.models = flags["models"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (!preset.displayName) preset.displayName = id;
      await upsertUserProvider(id, preset);
      if (flags["use"] === true) {
        await setUserActiveEndpoint({
          providerId: id,
          provider: preset.provider,
          model: preset.model,
          smallModel: preset.smallModel,
          baseURL: preset.baseURL,
          apiKey: preset.apiKey,
        });
      }
      process.stdout.write(`ok: provider "${id}" saved${flags["use"] === true ? " (active)" : ""}\n`);
      return 0;
    }
    case "remove":
    case "rm":
    case "delete": {
      const id = positional[1];
      if (!id) {
        process.stderr.write("usage: codepilot config remove <id>\n");
        return 2;
      }
      await deleteUserProvider(id);
      process.stdout.write(`ok: provider "${id}" removed\n`);
      return 0;
    }
    case "use": {
      const id = positional[1];
      if (!id) {
        process.stderr.write("usage: codepilot config use <id> [--model M]\n");
        return 2;
      }
      const { config } = await loadConfigWithSources(cwd);
      let preset = config.providers?.[id];
      if (!preset) {
        const tmpl = PROVIDER_TEMPLATES.find((t) => t.id === id);
        if (!tmpl) {
          process.stderr.write(`unknown provider: ${id}\n`);
          return 2;
        }
        preset = templateToPreset(tmpl);
        await upsertUserProvider(id, preset);
      }
      const model =
        (typeof flags["model"] === "string" ? flags["model"] : undefined) ??
        preset.model;
      await setUserActiveEndpoint({
        providerId: id,
        provider: preset.provider,
        model,
        smallModel: preset.smallModel,
        baseURL: preset.baseURL,
        apiKey: preset.apiKey,
      });
      process.stdout.write(`ok: active → ${id}${model ? ` · ${model}` : ""}\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown config subcommand: ${sub}\n\n${configHelp()}`);
      return 2;
  }
}

async function cmdServe(
  flags: Record<string, string | boolean>,
): Promise<number> {
  if (flags["web"] !== true) {
    const handle = await startServer();
 // Wait until stdin closes.
    await handle.peer.loopDone;
    return 0;
  }
  return cmdServeWeb(flags);
}

/** Fixed default for `serve --web` so bookmarks / scripts stay stable. */
const DEFAULT_WEB_PORT = 18765;

/**
 * `codepilot serve --web`: the same protocol over WebSocket, for browser
 * clients. Prints the URL (token included) to stdout and then runs until
 * interrupted. With `--web-root`, opens the browser to the UI with the token
 * in the query string so the SPA auto-connects (unless `--no-open`).
 */
async function cmdServeWeb(
  flags: Record<string, string | boolean>,
): Promise<number> {
  const { startWebSocketServer } = await import("./ws.js");
  const portFlag = flags["port"];
  const port =
    typeof portFlag === "string" ? Number(portFlag) : DEFAULT_WEB_PORT;
  if (!Number.isInteger(port) || port < 0) {
    process.stderr.write(`invalid --port: ${String(portFlag)}\n`);
    return 2;
  }
  const host = typeof flags["host"] === "string" ? flags["host"] : undefined;
  const token = typeof flags["token"] === "string" ? flags["token"] : undefined;
  const noAuth = flags["no-auth"] === true;
  const allowOrigin = flags["allow-origin"];
 // --web-root serves the built SPA (apps/web/dist) over plain HTTP on the
 // same port. "true" (bare --web-root) auto-detects apps/web/dist relative
 // to this package (installed layout: <pkg>/apps/web/dist next to
 // <pkg>/packages/protocol).
  const webRootFlag = flags["web-root"];
  let webRoot: string | undefined;
  if (webRootFlag === true) {
    webRoot = detectWebRoot("--web-root");
    if (!webRoot) return 2;
  } else if (typeof webRootFlag === "string") {
    if (!existsSync(join(webRootFlag, "index.html"))) {
      process.stderr.write(`--web-root: no index.html at ${webRootFlag}\n`);
      return 2;
    }
    webRoot = webRootFlag;
  }

 // Binding beyond loopback exposes an agent that can run shell commands, so
 // it has to be paired with a token. Refuse rather than warn.
  if (noAuth && host !== undefined && host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write(
      `refusing --no-auth with --host ${host}: that would let anyone who can ` +
        `reach this port run commands as you. Drop --no-auth, or bind loopback.\n`,
    );
    return 2;
  }

  let handle;
  try {
    handle = await startWebSocketServer({
      port,
      host,
      token,
      auth: noAuth ? "none" : "token",
      staticRoot: webRoot,
      allowedOrigins:
        typeof allowOrigin === "string" ? allowOrigin.split(",").map((s) => s.trim()) : undefined,
      onConnection: ({ count }) => {
        process.stderr.write(`[serve] clients: ${count}\n`);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (port !== 0 && /EADDRINUSE|address already in use/i.test(msg)) {
      process.stderr.write(
        `[serve] port ${port} is already in use — stop the other process or pass --port N\n`,
      );
      return 2;
    }
    throw err;
  }

  const pageUrl = webRoot
    ? (await import("./agent-app.js")).webPageUrl(
        handle.host,
        handle.port,
        handle.token,
      )
    : undefined;

  process.stdout.write(`${handle.url}\n`);
  process.stderr.write(
    `[serve] CodePilot protocol on ws://${handle.host}:${handle.port}\n` +
      (pageUrl
        ? `[serve] web UI: ${pageUrl.replace(/([?&]token=)[^&]*/g, "$1…")}\n`
        : "") +
      (handle.token
        ? `[serve] token: ${handle.token}\n`
        : `[serve] AUTH DISABLED — anything that can reach this port can run commands\n`),
  );

  if (pageUrl && flags["no-open"] !== true) {
    const { openBrowser } = await import("./agent-app.js");
    openBrowser(pageUrl);
    process.stderr.write(`[serve] opened browser\n`);
  }

 // Advertise this server so `codepilot chat` / `codepilot-tui` can detect it
 // and attach (follow the same sessions) instead of starting a second engine.
  const { writeServeInfo, clearServeInfo } = await import("./serve-info.js");
  await writeServeInfo({
    url: handle.url,
    token: handle.token ?? "",
    pid: process.pid,
    host: handle.host,
    port: handle.port,
    startedAt: new Date().toISOString(),
  });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void clearServeInfo().finally(() => {
        void handle.close().then(resolve, () => resolve());
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await clearServeInfo();
  return 0;
}

/** The built web SPA next to this package (`<repo>/apps/web/dist`). */
function detectWebRoot(what: string): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidate = resolve(here, "..", "..", "..", "apps", "web", "dist");
  if (existsSync(join(candidate, "index.html"))) return candidate;
  process.stderr.write(
    `${what}: no web UI at ${candidate}\n` +
      `Build it first (pnpm --filter @codepilot/web build) or pass --web-root <dir>.\n`,
  );
  return undefined;
}

/**
 * `codepilot agent [dir]`: serve the web UI and protocol on loopback and
 * open the agent layout in an app window. Exits when the window closes.
 */
async function cmdAgent(
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

  const { startWebSocketServer } = await import("./ws.js");
  const { agentPageUrl, openAgentWindow } = await import("./agent-app.js");
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

// ---------- interactive REPL ----------

/**
 * `codepilot` / `codepilot chat` / `codepilot repl`: a multi-turn interactive
 * conversation over stdio. Thinner than the Ink TUI (`codepilot-tui`) — no
 * fancy rendering, just readline + the same event renderer `run` uses — but
 * it makes `codepilot` itself usable interactively without spawning a second
 * binary.
 *
 * Slash commands: /mode <chat|plan|agent>, /model <name>, /clear, /help, /exit.
 * Up/Down arrows recall history (readline native). Ctrl+C cancels the current
 * turn (or exits if idle); Ctrl+D exits.
 */
async function cmdRepl(
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
      const { readLiveServeInfo } = await import("./serve-info.js");
      const info = await readLiveServeInfo();
      if (info) {
        const { cmdConnect } = await import("./cli-connect.js");
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
            stderr_.write(
              "Commands:\n" +
                "  /mode <chat|plan|agent>   set collaboration mode\n" +
                "  /model                    list selectable models\n" +
                "  /model <provider>/<model> switch model (any configured provider)\n" +
                "  /model <name>             switch model on current provider\n" +
                "  /provider <id>            switch provider preset\n" +
                "  /clear                    clear the screen\n" +
                "  /help                     show this help\n" +
                "  /exit                     exit (also Ctrl+D)\n",
            );
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
  return 0;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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