// CodePilot Agent: a desktop window around the shared web UI's agent layout.
//
// The protocol server runs in this process on a loopback port (token-gated)
// and also serves the built UI, so the page is the same app as `codepilot
// agent` and the web client. The preload adds a native folder picker and
// "open with default app".

import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from "electron";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

import { agentPageUrl } from "@codepilot/protocol/agent-app";
import { startWebSocketServer, type WebSocketServerHandle } from "@codepilot/protocol/ws";

import { findWebRoot, initialFolder, loadSettings, saveSettings } from "./settings.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const settingsFile = join(app.getPath("userData"), "settings.json");
const settings = loadSettings(settingsFile);
let server: WebSocketServerHandle | null = null;

app.setName("CodePilot Agent");

if (!app.requestSingleInstanceLock()) app.quit();

async function createWindow(folder: string): Promise<void> {
  const webRoot = findWebRoot([
    join(process.resourcesPath ?? "", "web"),
    resolve(here, "..", "..", "web", "dist"),
  ]);
  if (!webRoot) {
    dialog.showErrorBox("CodePilot Agent", "The web UI is not built. Run `pnpm --filter @codepilot/web build`.");
    app.quit();
    return;
  }
  server ??= await startWebSocketServer({ port: 0, host: "127.0.0.1", staticRoot: webRoot, defaultCwd: folder });

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
    },
  });
  const origin = `http://${server.host}:${server.port}`;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (ev, url) => {
    if (!url.startsWith(origin)) {
      ev.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.once("ready-to-show", () => win.show());
  await win.loadURL(`${agentPageUrl(server.host, server.port, server.token, folder)}&desktop=1`);

  const shot = process.env.CODEPILOT_DESKTOP_SCREENSHOT;
  if (shot) {
    setTimeout(async () => {
      writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, 2500);
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

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("window-all-closed", () => app.quit());

app.on("will-quit", () => {
  void server?.close();
});

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
  const folder = initialFolder(process.argv.slice(app.isPackaged ? 1 : 2), settings, app.getPath("home"), process.cwd());
  settings.lastFolder = folder;
  saveSettings(settingsFile, settings);
  return createWindow(folder);
});
