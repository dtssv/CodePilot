// CodePilot Agent: a desktop window around the shared web UI's agent layout.
//
// The engine is the *shared* local daemon (`codepilot serve --daemon`), the
// same one the web client and IDE plugins attach to — so sessions and the
// open workspace stay in sync across every surface. The window loads the
// built SPA over `file://` and connects to the daemon over WebSocket via the
// `?ws=&token=` auto-connect params. The preload adds a native folder picker
// and "open with default app".

import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import {
  readLiveServeInfo,
  type ServeInfo,
} from "@codepilot/protocol/serve-info";

import { findWebRoot, initialFolder, loadSettings, saveSettings } from "./settings.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
const settingsFile = join(app.getPath("userData"), "settings.json");
const settings = loadSettings(settingsFile);
/** Fixed port the shared daemon binds (and clients discover via serve.json). */
const DAEMON_PORT = 18765;
/** The daemon we may have spawned; left running for other clients on quit. */
let daemon: ServeInfo | null = null;
/** The resolved web UI root, remembered so a daemon restart can rebuild the
 * page URL without re-detecting it. */
let webRootPath: string | null = null;
/** The folder the current window opened, so a restart reloads the same cwd. */
let currentFolder: string | null = null;

app.setName("CodePilot Agent");

if (!app.requestSingleInstanceLock()) app.quit();

/** The built web UI: bundled next to the app when packaged, else the workspace build. */
function resolveWebRoot(): string | null {
  return findWebRoot([
    join(process.resourcesPath ?? "", "web"),
    resolve(here, "..", "..", "web", "dist"),
  ]);
}

/** Resolve the shared-daemon launch command (Electron running as plain Node). */
function daemonLaunch(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Electron's own binary can run arbitrary Node scripts with this flag set.
  const cliEntry = resolve(require.resolve("@codepilot/protocol/package.json"), "..", "dist", "cli.js");
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODEPILOT_CLIENT: "desktop" };
  const args = [cliEntry, "serve", "--daemon", "--port", String(DAEMON_PORT)];
  // Serve the bundled SPA over plain HTTP so a paired phone can load the UI:
  // the /remote/pair redirect sends the phone to `GET /?token=…`, which only
  // works when the daemon has a static web root. Without this the phone hits
  // the "requires a WebSocket upgrade" page. The CLI auto-detect can't find
  // the app's resources/web, so pass it explicitly.
  const webRoot = webRootPath ?? resolveWebRoot();
  if (webRoot) args.push("--web-root", webRoot);
  // LAN access (opt-in): bind all interfaces so a phone on the same Wi‑Fi can
  // reach the QR remote-control URL. Token auth stays on; serve.json still
  // advertises loopback so local discovery is unaffected.
  if (settings.lanAccess) args.push("--host", "0.0.0.0");
  return { command: process.execPath, args, env };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Prefer an already-running loopback daemon (the one the web client / IDE
 * plugins share); otherwise spawn one and wait for its lockfile. Detached so
 * closing the app does not kill a daemon other clients may still use.
 */
async function discoverOrStartDaemon(cwd: string): Promise<ServeInfo> {
  const existing = await readLiveServeInfo();
  if (existing) {
    // Reuse only if it speaks our protocol (has the extended git ops) AND its
    // bind matches the LAN-access preference. A loopback-only daemon left by
    // the web/IDE client would otherwise be reused even when the user asked for
    // LAN access, so the phone's QR URL stays unreachable — the "toggle did
    // nothing" bug. Replace a mismatched daemon.
    if ((await daemonHasGit(existing)) && (await daemonBindMatchesPref())) return existing;
    try {
      process.kill(existing.pid);
    } catch {
      /* already gone */
    }
    // Wait for the OLD daemon to actually release the port, not merely clear
    // serve.json. A graceful SIGTERM (disconnect clients + http.close) can take
    // longer than the serve.json unlink, and binding before the port is free
    // makes the new daemon exit with EADDRINUSE — the root cause of the
    // "did not publish serve.json within 15s" failure on first launch after an
    // upgrade. Poll the port itself, up to ~8s.
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (!(await portInUse(DAEMON_PORT))) break;
    }
  } else if (await portInUse(DAEMON_PORT)) {
    // No usable serve.json, yet the port is held. This is a stale daemon from a
    // previous (e.g. pre-upgrade) run whose serve.json was cleared/emptied but
    // whose process still owns the port. Spawning now would hit EADDRINUSE and
    // fail with the "did not publish serve.json within 15s" timeout. Free the
    // port by terminating whatever holds it, then wait for release.
    await freeStaleDaemonPort(DAEMON_PORT);
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (!(await portInUse(DAEMON_PORT))) break;
    }
  }

  const launch = daemonLaunch();
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: launch.env,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const info = await readLiveServeInfo();
    if (info && (await daemonHasGit(info))) return info;
    await sleep(150);
  }
  // Last resort before giving up: a concurrent CodePilot (or a daemon we failed
  // to replace cleanly) may already hold the port and have published a valid
  // serve.json. If our spawned child lost the port race and exited with
  // EADDRINUSE, reusing that live daemon is correct — don't error out.
  const raced = await readLiveServeInfo();
  if (raced && (await daemonHasGit(raced))) return raced;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  throw new Error("the daemon did not publish ~/.codepilot/serve.json within 15s");
}

/**
 * Stop the shared daemon we launched and start a fresh one that reflects the
 * current settings (chiefly the LAN bind). Because the token is minted per
 * start, the renderer must reconnect with the NEW serve.json — so after the
 * daemon republishes its lockfile we reload every window with a fresh page URL
 * (new token, same loopback host). Returns false if no new daemon came up.
 */
async function restartDaemon(): Promise<boolean> {
  if (!webRootPath) return false;
  // Kill the daemon we know about and wait for the port to actually free, so
  // the new daemon does not lose the bind race (EADDRINUSE). Fall back to any
  // live serve.info pid if our handle is stale.
  const live = daemon ?? (await readLiveServeInfo());
  if (live) {
    try {
      process.kill(live.pid);
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (!(await portInUse(DAEMON_PORT))) break;
    }
  }
  daemon = null;

  try {
    daemon = await discoverOrStartDaemon(currentFolder ?? app.getPath("home"));
  } catch {
    return false;
  }

  // Reload each window against the fresh daemon so the SPA auto-connects with
  // the new token instead of retrying the stale one.
  for (const win of BrowserWindow.getAllWindows()) {
    void win.loadURL(pageUrl(webRootPath, daemon, currentFolder));
  }
  return true;
}

/** Is a TCP port accepting connections on the given host? Used to confirm a
 * killed daemon has released its port, and whether a daemon is LAN-reachable. */
function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (used: boolean): void => {
      socket.destroy();
      resolve(used);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/**
 * Terminate whatever process holds `port` (a stale CodePilot daemon left after
 * an upgrade whose serve.json was cleared). Best-effort and cross-platform:
 * finds the listening PID and sends SIGTERM (then SIGKILL on POSIX). Never
 * throws — the caller re-polls the port and falls back to the EADDRINUSE path.
 */
async function freeStaleDaemonPort(port: number): Promise<void> {
  const { execFile } = await import("node:child_process");
  const run = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 4000 }, (_err, stdout) => resolve(stdout ?? ""));
    });
  try {
    const pids = new Set<number>();
    if (process.platform === "win32") {
      // netstat → PID in the last column for the LISTENING line on this port.
      const out = await run("netstat", ["-ano", "-p", "tcp"]);
      for (const line of out.split(/\r?\n/)) {
        if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
          const pid = Number(line.trim().split(/\s+/).pop());
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
      }
    } else {
      // lsof lists the listening PID(s) for the TCP port.
      const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      for (const p of out.split(/\s+/)) {
        const pid = Number(p.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (pids.size > 0 && process.platform !== "win32") {
      await sleep(600);
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  } catch {
    /* best-effort; caller re-polls and handles the EADDRINUSE race */
  }
}

/** This machine's primary IPv4 LAN address, or undefined when offline. */
function lanIp(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

/**
 * Does the running daemon's bind match the current LAN-access preference?
 * serve.json always advertises loopback (so local discovery works), so we
 * cannot read the bind from it — instead we probe the LAN IP directly. A
 * loopback-only daemon refuses the LAN connection; a 0.0.0.0 daemon accepts it.
 * When LAN access is off, any reachable daemon is acceptable (we don't force a
 * restart just to narrow the bind). Returns true when no change is needed.
 */
async function daemonBindMatchesPref(): Promise<boolean> {
  if (!settings.lanAccess) return true; // off: don't care about the bind
  const ip = lanIp();
  if (!ip) return true; // offline: LAN bind is moot, avoid churn
  return portInUse(DAEMON_PORT, ip); // on: must be reachable over the LAN
}

/** Probe a running daemon's initialize capabilities for the extended git ops. */
function daemonHasGit(info: ServeInfo): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const base = info.url.replace(/[?#].*$/, "");
    const url = info.token ? `${base}?token=${encodeURIComponent(info.token)}` : base;
    let ws: import("ws").WebSocket;
    try {
      const WS = require("ws") as typeof import("ws").WebSocket;
      ws = new WS(url, { headers: { Origin: "null" } });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => done(false), 3000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, capabilities: {}, clientInfo: { name: "codepilot-desktop", version: "probe" } } }));
    });
    ws.on("message", (data: unknown) => {
      try {
        const msg = JSON.parse(String(data)) as { id?: number; result?: { capabilities?: { git?: boolean } } };
        if (msg.id === 1) {
          clearTimeout(timer);
          done(msg.result?.capabilities?.git === true);
        }
      } catch {
        /* ignore */
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

/** The SPA page URL (file://) wired to auto-connect to the daemon over ws. */
function pageUrl(webRoot: string, info: ServeInfo, folder: string | null): string {
  const indexUrl = pathToFileURL(join(webRoot, "index.html"));
  // Clean socket URL (no token in the query) — the SPA appends `token` itself.
  const wsBase = info.url.replace(/[?#].*$/, "");
  const q = new URLSearchParams({ layout: "web", desktop: "1", ws: wsBase });
  if (folder) q.set("cwd", folder);
  if (info.token) q.set("token", info.token);
  indexUrl.search = q.toString();
  return indexUrl.toString();
}

/** Send a UI command to the focused window's renderer. */
function sendToUi(channel: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send(channel);
}

/** Build the native application menu (Settings, Check for updates, etc.). */
function buildMenu(): void {
  const isMac = process.platform === "darwin";
  const appName = "CodePilot Agent";

  const settingsItem = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => sendToUi("codepilot:menu-settings"),
  };
  const checkUpdatesItem = {
    label: "Check for Updates…",
    click: () => sendToUi("codepilot:menu-check-updates"),
  };
  const lanAccessItem = {
    label: "Allow LAN Access (phone remote control)",
    type: "checkbox" as const,
    checked: settings.lanAccess === true,
    click: (item: Electron.MenuItem) => {
      settings.lanAccess = item.checked;
      saveSettings(settingsFile, settings);
      // Apply immediately by restarting the shared daemon (same as the web
      // Settings toggle) — no app restart required.
      void restartDaemon();
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: [
              { role: "about" as const },
              checkUpdatesItem,
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const },
              lanAccessItem,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(isMac ? [] : [settingsItem, checkUpdatesItem, lanAccessItem, { type: "separator" as const }]),
        { role: "close" as const },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" as const },
        { role: "zoom" as const },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(folder: string | null): Promise<void> {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    dialog.showErrorBox("CodePilot Agent", "The web UI is not built. Run `pnpm --filter @codepilot/web build`.");
    app.quit();
    return;
  }
  webRootPath = webRoot;
  currentFolder = folder;

  if (!daemon) {
    try {
      daemon = await discoverOrStartDaemon(folder ?? app.getPath("home"));
    } catch (err) {
      dialog.showErrorBox(
        "CodePilot Agent",
        `Could not start the CodePilot engine: ${err instanceof Error ? err.message : String(err)}`,
      );
      app.quit();
      return;
    }
  }

  const mac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "CodePilot Agent",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0d12" : "#f5f6f9",
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Enable the in-app browser panel (<webview> element in the SPA).
      webviewTag: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stderr.write(`[desktop] page failed to load (${code} ${desc}): ${url}\n`);
  });
  if (process.env.CODEPILOT_DESKTOP_DEBUG) {
    // Electron ≥36 passes a single event object; older passes positional args.
    win.webContents.on("console-message", (...args: unknown[]) => {
      const ev = args[0] as { message?: string; level?: string } | undefined;
      const msg = typeof args[2] === "string" ? args[2] : ev?.message ?? "";
      process.stderr.write(`[renderer] ${msg}\n`);
    });
    process.stderr.write(`[desktop] loading ${pageUrl(webRoot, daemon as ServeInfo, folder).slice(0, 110)}\n`);
  }
  win.webContents.on("will-navigate", (ev, url) => {
    if (!url.startsWith("file://")) {
      ev.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.once("ready-to-show", () => win.show());
  await win.loadURL(pageUrl(webRoot, daemon, folder));

  const shot = process.env.CODEPILOT_DESKTOP_SCREENSHOT;
  if (shot) {
    const delayMs = Number(process.env.CODEPILOT_DESKTOP_SCREENSHOT_DELAY ?? "2500");
    setTimeout(async () => {
      writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, delayMs);
  }
}

ipcMain.handle("codepilot:pick-folder", async (ev) => {
  const win = BrowserWindow.fromWebContents(ev.sender);
  const opts = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">, defaultPath: settings.lastFolder };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const folder = res.canceled ? null : res.filePaths[0] ?? null;
  if (folder) {
    settings.lastFolder = folder;
    saveSettings(settingsFile, settings);
  }
  return folder;
});

ipcMain.handle("codepilot:open-path", async (_ev, path: unknown) => {
  if (typeof path !== "string" || !isAbsolute(path)) return;
  const err = await shell.openPath(path);
  if (err) dialog.showErrorBox("CodePilot Agent", err);
});

ipcMain.handle("codepilot:get-lan-access", () => settings.lanAccess === true);

ipcMain.handle("codepilot:set-lan-access", async (_ev, enabled: unknown) => {
  const next = enabled === true;
  if (settings.lanAccess !== next) {
    settings.lanAccess = next;
    saveSettings(settingsFile, settings);
    buildMenu(); // keep the native checkbox in sync
    // Restart the shared daemon so the new bind takes effect immediately —
    // no app restart needed. If the restart fails, the preference is still
    // saved and will apply on next launch.
    await restartDaemon();
  }
  return settings.lanAccess === true;
});

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// The in-app browser <webview>: keep popups (window.open / target=_blank
// inside visited pages) out of the app — hand them to the system browser.
app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  }
});

// macOS convention: closing the last window keeps the app alive in the Dock;
// re-activating recreates a window. Other platforms quit.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow(settings.lastFolder ?? null);
  }
});

// Do not kill the shared daemon on quit: other clients (web / IDE) may still
// be attached; it exits on its own idle grace after the last client leaves.

void app.whenReady().then(() => {
  if (
    process.env.CODEPILOT_SKIP_UPDATE !== "1" &&
    process.env.CODEPILOT_NO_UPDATE !== "1"
  ) {
    void import("@codepilot/core")
      .then((core) => {
        core.startSelfUpdateWatcher();
      })
      .catch(() => undefined);
  }
  const folder = initialFolder(process.argv.slice(app.isPackaged ? 1 : 2), settings, process.cwd());
  if (folder) {
    settings.lastFolder = folder;
    saveSettings(settingsFile, settings);
  }
  buildMenu();
  return createWindow(folder);
});
