// `codepilot connect` — attach the terminal to a RUNNING `codepilot serve`
// as a protocol client, and follow a live session in real time.
//
// Unlike `codepilot chat`, which spins up its own in-process engine (a
// separate program that only shares the on-disk JSONL), this connects over
// WebSocket to the same serve the web UI uses. So a task started in the web
// streams into the terminal live, and prompts typed here drive the same
// shared session. This is the terminal counterpart of opening the web UI.

import * as readline from "node:readline";
import type { Event } from "@codepilot/core";
import { Peer } from "./rpc.js";
import { WebSocketTransport } from "./ws.js";
import { PROTOCOL_VERSION } from "./server.js";
import { PrettyRenderer, prettyOutput } from "./cli-render.js";

interface ConnectOpts {
  url: string;
  token?: string;
 /** Resume a specific session id → follow it (two-end sync). */
  sessionId?: string;
 /** Start a fresh session instead of attaching to an existing one. */
  fresh?: boolean;
 /** When no sessionId, follow the server's NEWEST session. Opt-in; default
 * (false) starts a fresh session so we never hijack another client's. */
  attachNewest?: boolean;
  cwd?: string;
}

interface SessionSummary {
  id: string;
  title?: string;
  updatedAt?: number;
  cwd?: string;
}

/** Build the ws URL with the token in the query string (browsers can't set
 * headers on the handshake, so the server accepts ?token=). */
function wsUrl(url: string, token?: string): string {
  let u = url.trim();
  if (!/^wss?:\/\//.test(u)) u = `ws://${u}`;
 // Don't double-append: the url may already carry ?token= (e.g. from
 // serve.json). Only add when absent.
  if (token && !/[?&]token=/.test(u)) {
    u += (u.includes("?") ? "&" : "?") + `token=${encodeURIComponent(token)}`;
  }
  return u;
}

export async function cmdConnect(opts: ConnectOpts): Promise<number> {
  const stderr = process.stderr;
  const stdout = process.stdout;

 // Dynamic import so the `ws` client is only loaded for this command.
  const WsMod = await import("ws");
  const WebSocket = WsMod.WebSocket ?? WsMod.default;
  const socket = new WebSocket(wsUrl(opts.url, opts.token));

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (e: Error) => reject(e));
  }).catch((e: Error) => {
    stderr.write(`[connect] failed to reach ${opts.url}: ${e.message}\n`);
    throw e;
  });

  const transport = new WebSocketTransport(socket);
  const peer = new Peer({ transport });

 // The server may send reverse requests (permission / question). Answer them
 // interactively so a command started here isn't left hanging.
  peer.onRequest("permission/request", async (p: unknown) => {
    const req = p as { reason?: string; toolName?: string };
    stderr.write(`\n[permission] ${req.toolName ?? "?"} — ${req.reason ?? ""}\n  allow once (y) / always (a) / deny (n)? `);
    const ans = await readOneLine();
    const d = ans.trim().toLowerCase();
    return { decision: d === "a" ? "always" : d === "y" ? "allow" : "deny" };
  });
  peer.onRequest("question/request", async (p: unknown) => {
    const req = p as { questions?: { id: string; question: string }[] };
    const answers: Record<string, string> = {};
    for (const q of req.questions ?? []) {
      stderr.write(`\n[question] ${q.question}\n> `);
      answers[q.id] = (await readOneLine()).trim();
    }
    return { answers };
  });

  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    cwd: opts.cwd ?? process.cwd(),
    permissionMode: "ask",
    clientInfo: { name: "codepilot-connect", version: "0" },
  });

 // Resolve which session to use.
 // sessionId → follow it. attachNewest → follow the newest. Otherwise
 // fall through to creating a fresh session below (don't hijack another
 // client's current session just because we connected).
  let sessionId = opts.sessionId;
  if (!sessionId && !opts.fresh && opts.attachNewest) {
    const { sessions } = await peer.request<unknown, { sessions: SessionSummary[] }>(
      "session/list",
      {},
    );
    const newest = [...(sessions ?? [])].sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    )[0];
    sessionId = newest?.id;
    if (sessionId) {
      stderr.write(`[connect] following session ${sessionId}${newest?.title ? ` — ${newest.title}` : ""}\n`);
    }
  }

 // Render live events for our session, reusing the same pretty renderer the
 // local REPL uses (falls back to plain text when stdout isn't a TTY).
  const renderer = prettyOutput(stdout) ? new PrettyRenderer(stdout) : null;
  const render = (event: Event): void => {
    if (renderer) {
      renderer.render(event);
      return;
    }
    if (event.type === "message_delta" && event.delta.type === "text") stdout.write(event.delta.text);
    else if (event.type === "message" && event.role === "assistant") {
      for (const b of event.content) if (b.type === "text") stdout.write(b.text);
    } else if (event.type === "tool_call") stdout.write(`\n[tool:${event.name}]\n`);
    else if (event.type === "tool_result") stdout.write(`[result${event.isError ? " error" : ""}]\n`);
    else if (event.type === "status") stdout.write(`\n[status:${event.status}]\n`);
  };
  const sentHere: string[] = [];
  peer.onNotification("event", (p: unknown) => {
    const { sessionId: sid, event } = p as { sessionId: string; event: Event };
    if (sid !== sessionId) return; // another session on the same connection
 // Prompts typed in another client (web, TUI) are part of the shared
 // conversation; the renderer only knows assistant output.
    if (event.type === "message" && event.role === "user") {
      const text = event.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const i = sentHere.indexOf(text);
      if (i >= 0) sentHere.splice(i, 1); // already on screen as typed
      else stdout.write(`\n> ${text}\n`);
      return;
    }
    render(event);
  });

  if (sessionId) {
 // Resume: the result carries the history; new events stream in live.
    const res = await peer.request<unknown, { events?: Event[] }>("session/resume", { sessionId });
    for (const e of res.events ?? []) {
      if (e.type === "message" && e.role === "user") {
        const text = e.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        stdout.write(`\n> ${text}\n`);
      } else {
        render(e);
      }
    }
  } else {
    const res = await peer.request<unknown, { sessionId: string }>("session/new", {
      cwd: opts.cwd ?? process.cwd(),
    });
    sessionId = res.sessionId;
    stderr.write(`[connect] new session ${sessionId}\n`);
  }

  stderr.write(
    `[connect] attached. Type a message to drive this session; Ctrl+C cancels the current turn, Ctrl+D exits.\n`,
  );

 // Prompt loop over stdin.
  const rl = readline.createInterface({ input: process.stdin, output: stderr, prompt: "" });
  let readResolve: ((line: string) => void) | null = null;
  rl.on("line", (line) => {
    if (readResolve) {
      const r = readResolve;
      readResolve = null;
      r(line);
      return;
    }
    const text = line.trim();
    if (text) {
      sentHere.push(text);
      void peer.request("prompt/send", { sessionId, text }).catch(() => {});
    }
  });

  function readOneLine(): Promise<string> {
    return new Promise((resolve) => {
      readResolve = resolve;
    });
  }

 // Ctrl+C cancels the current turn (does not exit — Ctrl+D exits).
  rl.on("SIGINT", () => {
    void peer.request("prompt/cancel", { sessionId }).catch(() => {});
    stderr.write("\n[cancelling…]\n");
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
    socket.on("close", () => resolve());
  });

  try {
    await peer.close();
  } catch {
 /* ignore */
  }
  return 0;
}
