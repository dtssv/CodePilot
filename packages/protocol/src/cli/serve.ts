import { killAllJobs } from "@codepilot/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectWebRoot } from "../agent-app.js";
import { materializeEmbeddedWeb } from "../web-embed.js";
import { startServer } from "../server.js";
import { startWebSocketServer } from "../ws.js";

export async function cmdServe(
  flags: Record<string, string | boolean>,
): Promise<number> {
  // --daemon is the shared-engine mode used by IDE plugins: WebSocket + lockfile,
  // no browser open, exit after last client + idle grace.
  if (flags["daemon"] === true) {
    flags = { ...flags, web: true, "no-open": true, daemon: true };
  }
  if (flags["web"] !== true) {
    const handle = await startServer();
 // Wait until stdin closes.
    await handle.peer.loopDone;
    await killAllJobs().catch(() => {});
    return 0;
  }
  return cmdServeWeb(flags);
}

/** Fixed default for `serve --web` so bookmarks / scripts stay stable. */
const DEFAULT_WEB_PORT = 18765;

/**
 * `codepilot serve --web`: protocol over WebSocket for browser clients.
 * Prints the token-bearing URL to stdout and runs until interrupted.
 */
export async function cmdServeWeb(
  flags: Record<string, string | boolean>,
): Promise<number> {
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
    // Prefer the SPA embedded in this binary; fall back to the filesystem
    // layout (source / npm) when nothing is embedded.
    webRoot = materializeEmbeddedWeb() ?? detectWebRoot("--web-root");
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

  const daemonMode = flags["daemon"] === true;
  /** After the last WebSocket client leaves, wait this long then exit (daemon only). */
  const IDLE_GRACE_MS = 30_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  // Idle-exit with scheduler keep-alive: when the last client disconnects we
  // normally shut the daemon down after a grace period. But if there are still
  // PENDING scheduled tasks (enabled, not paused, not expired), shutting down
  // would mean "installed but never runs" — so we keep the daemon alive and
  // re-check later instead. With no pending tasks the daemon idle-exits as usual.
  const armIdleShutdown = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    idleTimer = setTimeout(() => {
      void (async () => {
        if (shuttingDown) return;
        let pending = false;
        try {
          const { hasPendingScheduledTasks } = await import("@codepilot/core");
          pending = await hasPendingScheduledTasks();
        } catch {
          /* fail-soft: if we can't read the store, don't block shutdown */
        }
        if (pending) {
          process.stderr.write(
            `[serve] no clients, but scheduled tasks pending — staying alive for the scheduler\n`,
          );
          armIdleShutdown();
          return;
        }
        process.stderr.write(
          `[serve] no clients for ${IDLE_GRACE_MS / 1000}s — shutting down daemon\n`,
        );
        process.emit("SIGTERM");
      })();
    }, IDLE_GRACE_MS);
    idleTimer.unref?.();
  };

  // Identity recorded in each session's write-lease lock file so a second
  // process trying to open the same session can be redirected to attach to THIS
  // daemon as a subscriber. The url is filled in after the handle resolves (it
  // needs the bound port); the lock identity object is shared by reference with
  // the server options, which acceptConnection reads fresh per connection.
  const lockIdentity: { host?: string; url?: string; token?: string } = {
    host: "daemon",
    ...(token ? { token } : {}),
  };

  let handle: Awaited<ReturnType<typeof startWebSocketServer>>;
  try {
    handle = await startWebSocketServer({
      lockIdentity,
      port,
      host,
      // In daemon mode, when bound beyond loopback (e.g. desktop LAN access
      // via --host 0.0.0.0), still advertise 127.0.0.1 in serve.json so the
      // loopback-only discovery guard (readLiveServeInfo) keeps working and
      // local clients attach over loopback. The LAN bind remains reachable for
      // phone remote control via the QR's LAN IP.
      advertiseHost:
        daemonMode && host !== undefined && host !== "127.0.0.1" && host !== "localhost"
          ? "127.0.0.1"
          : undefined,
      token,
      auth: noAuth ? "none" : "token",
      staticRoot: webRoot,
      allowedOrigins:
        typeof allowOrigin === "string" ? allowOrigin.split(",").map((s) => s.trim()) : undefined,
      onConnection: ({ count }) => {
        process.stderr.write(`[serve] clients: ${count}\n`);
        if (!daemonMode) return;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (count === 0 && !shuttingDown) {
          armIdleShutdown();
        }
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (port !== 0 && /EADDRINUSE|address already in use/i.test(msg)) {
      // Another CodePilot already holds the port — clients should attach via
      // ~/.codepilot/serve.json instead of starting a second bind.
      const { readLiveServeInfo } = await import("../serve-info.js");
      const live = await readLiveServeInfo();
      if (live) {
        process.stderr.write(
          `[serve] port ${port} already in use by a live CodePilot at ${live.url} — attach to it instead of binding again\n`,
        );
      } else {
        process.stderr.write(
          `[serve] port ${port} is already in use — stop the other process or pass --port N\n`,
        );
      }
      return 2;
    }
    throw err;
  }

  const pageUrl = webRoot
    ? (await import("../agent-app.js")).webPageUrl(
        handle.host,
        handle.port,
        handle.token,
      )
    : undefined;

  // Now that the port is bound, record this daemon's attach url in the shared
  // lock-identity object so session lock files written from here carry a usable
  // redirect target.
  lockIdentity.url = handle.url;

  process.stdout.write(`${handle.url}\n`);
  process.stderr.write(
    `[serve] CodePilot protocol on ws://${handle.host}:${handle.port}` +
      (daemonMode ? " (daemon)\n" : "\n") +
      (pageUrl
        ? `[serve] web UI: ${pageUrl.replace(/([?&]token=)[^&]*/g, "$1…")}\n`
        : "") +
      (handle.token
        ? `[serve] token: ${handle.token}\n`
        : `[serve] AUTH DISABLED — anything that can reach this port can run commands\n`),
  );

  if (pageUrl && flags["no-open"] !== true) {
    const { openBrowser } = await import("../agent-app.js");
    openBrowser(pageUrl);
    process.stderr.write(`[serve] opened browser\n`);
  }

 // Advertise this server so `codepilot chat` / `codepilot-tui` / IDE plugins can
 // detect it and attach (follow the same sessions) instead of starting a second engine.
  const { writeServeInfo, clearServeInfo } = await import("../serve-info.js");
  let version: string | undefined;
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    version = (req("../package.json") as { version?: string }).version;
  } catch {
    /* optional */
  }
  const serveInfo = {
    url: handle.url,
    token: handle.token ?? "",
    pid: process.pid,
    host: handle.host,
    port: handle.port,
    startedAt: new Date().toISOString(),
    version,
  };
  await writeServeInfo(serveInfo);
  // Re-assert the discovery file while the daemon lives. A racing reader that
  // momentarily saw a stale pid can delete serve.json (readLiveServeInfo cleans
  // up dead-pid files); without this, a live daemon would stay undiscoverable
  // and hold its port with no way for clients to learn its token. Cheap, so
  // keep it frequent; unref so it never keeps the process alive on its own.
  const reassert =
    daemonMode
      ? setInterval(() => {
          void writeServeInfo(serveInfo);
        }, 5_000)
      : null;
  reassert?.unref?.();

  // Boot-time crash recovery: seal sessions left in-flight by a crashed daemon
  // to clean idle (side-effect-safe results for orphaned tool calls + recovery
  // hint). Seal-and-idle only — never auto-re-enter the loop (prior tools may
  // have executed). Gated on sessions.reconcileOnBoot (default true); fail-soft
  // and background so it never delays startup.
  void (async () => {
    try {
      const { loadConfig, recoverSuspendedSessions } = await import("@codepilot/core");
      const cfg = await loadConfig(process.cwd()).catch(() => undefined);
      if (cfg?.sessions?.reconcileOnBoot === false) return;
      const summary = await recoverSuspendedSessions({ config: cfg });
      if (summary.sealed > 0) {
        process.stderr.write(
          `[serve] reconcile: sealed ${summary.sealed} interrupted session(s)` +
            ` (scanned ${summary.scanned}, skipped ${summary.skipped}): ` +
            `${summary.recovered.map((r) => r.id).join(", ")}\n`,
        );
      }
    } catch {
      /* fail-soft: recovery is best-effort, never blocks the daemon */
    }
  })();

  // Boot-time housekeeping: delete non-pinned sessions older than
  // sessions.retentionDays and cold-compress long-inactive ones to .jsonl.br.
  // Fail-soft, background, run once.
  void (async () => {
    try {
      const { loadConfig, sweepSessionRetention, compressColdSessions } = await import(
        "@codepilot/core"
      );
      const cfg = await loadConfig(process.cwd()).catch(() => undefined);
      const retention = await sweepSessionRetention({ config: cfg });
      if (retention.deleted.length > 0) {
        process.stderr.write(
          `[serve] retention: deleted ${retention.deleted.length} old session(s)\n`,
        );
      }
      const cold = await compressColdSessions({ config: cfg });
      if (cold.compressed.length > 0) {
        process.stderr.write(
          `[serve] cold-store: compressed ${cold.compressed.length} inactive session(s)\n`,
        );
      }
    } catch {
      /* fail-soft: housekeeping is best-effort, never blocks the daemon */
    }
  })();

  // Idle / scheduled tasks: run when no live session is busy.
  const { startSchedulerWatcher, createSession } = await import("@codepilot/core");
  const { anyLiveSessionBusy, deliverScheduledFollowup } = await import("../server.js");
  let idleSince = Date.now();
  const scheduler = startSchedulerWatcher({
    isIdle: () => {
      const busy = anyLiveSessionBusy();
      if (busy) idleSince = Date.now();
      return !busy;
    },
    idleForMs: () => (anyLiveSessionBusy() ? 0 : Date.now() - idleSince),
    run: async (task) => {
      // Follow-up delivery: post the prompt into an existing session instead of
      // opening a fresh one, so results land in a conversation the user has.
      if (task.delivery && task.delivery !== "new_session") {
        return deliverScheduledFollowup(task.delivery.sessionId, task.prompt, async (id) => {
          try {
            const session = await createSession({ cwd: task.cwd, sessionId: id });
            return { session, dispose: () => session.dispose() };
          } catch {
            return null;
          }
        });
      }
      try {
        const agentMode = task.agentMode ?? "agent";
        const session = await createSession({
          cwd: task.cwd,
          model: task.model,
          agentMode,
          config: {
            permissionMode: "ask",
            agentMode,
            ...(task.model ? { model: task.model } : {}),
          },
        });
        try {
          if (task.model) {
            await session.setModel(task.model, task.providerId).catch(() => undefined);
          }
          await session.prompt(task.prompt);
          // Wait until the turn finishes (idle again) or timeout.
          const deadline = Date.now() + 30 * 60 * 1000;
          while (session.isBusy() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
          }
          return { ok: true };
        } finally {
          await session.dispose().catch(() => {});
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
  process.stderr.write(`[serve] scheduler watching idle/scheduled tasks\n`);

  // Daemon: arm idle-exit immediately when no client is attached yet. Without
  // this, a freshly spawned daemon (install restart, desktop not open) never
  // sees a connect→disconnect edge and would run forever.
  if (daemonMode && handle.connectionCount() === 0 && !shuttingDown) {
    armIdleShutdown();
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      scheduler.stop();
      if (reassert) clearInterval(reassert);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      // Tear the server down FIRST, then drop the discovery file. Clearing
      // serve.json before close lets a hung socket (http.close never resolving)
      // strand a process that still holds the port but is no longer
      // discoverable — an undiscoverable zombie. A short cap on close ensures
      // we proceed even if a socket refuses to drain.
      const closed = Promise.race([
        handle.close().catch(() => {}),
        new Promise<void>((r) => {
          setTimeout(r, 3_000).unref?.();
        }),
      ]);
      void closed.finally(() => {
        void clearServeInfo().finally(() => resolve());
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await clearServeInfo();
  return 0;
}
