// The only bridge between the page and Electron: `window.codepilotDesktop`
// (declared in apps/web/src/App.tsx).

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("codepilotDesktop", {
  platform: process.platform,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("codepilot:pick-folder"),
  openPath: (path: string): void => {
    void ipcRenderer.invoke("codepilot:open-path", path);
  },
  /** Current LAN-access preference (daemon bound to 0.0.0.0 for phone QR). */
  getLanAccess: (): Promise<boolean> => ipcRenderer.invoke("codepilot:get-lan-access"),
  /** Toggle LAN access; the main process restarts the shared daemon so the
   * change takes effect immediately. Resolves to the new value. */
  setLanAccess: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("codepilot:set-lan-access", enabled),
  /** Subscribe to native-menu commands. Returns an unsubscribe function. */
  onMenu: (handler: (cmd: "settings" | "check-updates") => void): (() => void) => {
    const onSettings = (): void => handler("settings");
    const onCheck = (): void => handler("check-updates");
    ipcRenderer.on("codepilot:menu-settings", onSettings);
    ipcRenderer.on("codepilot:menu-check-updates", onCheck);
    return () => {
      ipcRenderer.removeListener("codepilot:menu-settings", onSettings);
      ipcRenderer.removeListener("codepilot:menu-check-updates", onCheck);
    };
  },
});
