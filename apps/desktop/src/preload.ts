// The only bridge between the page and Electron: `window.codepilotDesktop`
// (declared in apps/web/src/App.tsx).

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("codepilotDesktop", {
  platform: process.platform,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("codepilot:pick-folder"),
  openPath: (path: string): void => {
    void ipcRenderer.invoke("codepilot:open-path", path);
  },
});
