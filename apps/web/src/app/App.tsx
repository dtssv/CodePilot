import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HostBridge } from "../protocol/bridge.js";
import { useCodepilot } from "../state/useCodepilot.js";
import { loadPrefs, savePrefs, sameCwd } from "../prefs.js";
import {
  applyLayout,
  applyTheme,
  applyThemeName,
  detectSurface,
  initialTheme,
  initialThemeName,
  saveLayout,
  type Layout,
  type Surface,
  type Theme,
  type ThemeName,
} from "../surface.js";
import { applyHostLocale, t, useLocale } from "../i18n.js";
import { Toast } from "../components/Chrome.js";
import { parseReference } from "../state/paths.js";
import { OnboardingGuide } from "../components/OnboardingGuide.js";
import { notifyTurnComplete, primeNotifications } from "../state/notifications.js";
import { openResolvedPath } from "./helpers.js";
import { AgentLayout } from "./AgentLayout.js";
import { EmbeddedLayout } from "./EmbeddedLayout.js";
import { WebLayout } from "./WebLayout.js";

declare global {
  interface Window {
 /** Preload API of the desktop (Electron) agent app. */
    codepilotDesktop?: {
      platform: string;
      pickFolder(): Promise<string | null>;
      openPath(path: string): void;
      /** Current LAN-access preference (daemon bound to 0.0.0.0 for phone QR). */
      getLanAccess?(): Promise<boolean>;
      /** Toggle LAN access; the host restarts the shared daemon so the change
       * takes effect immediately. Resolves to the new value. */
      setLanAccess?(enabled: boolean): Promise<boolean>;
      onMenu?(handler: (cmd: "settings" | "check-updates") => void): () => void;
    };
 /** Registered by the desktop in-app browser panel to open http(s) links. */
    __codepilotOpenBrowser?: (url: string) => void;
  }
}

export function App(): React.ReactElement {
  useLocale();
  const surface = useMemo<Surface>(detectSurface, []);
  const [layout, setLayout] = useState<Layout>(surface.layout);
  const [theme, setTheme] = useState<Theme>(() => initialTheme(surface.host));
  const [themeName, setThemeName] = useState<ThemeName>(initialThemeName);
  const cp = useCodepilot();
  const cpRef = useRef(cp);
  cpRef.current = cp;
  const [draft, setDraft] = useState("");
  const bridgeRef = useRef<HostBridge | null>(null);
  if (surface.host && bridgeRef.current === null) bridgeRef.current = new HostBridge(surface.host);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => applyThemeName(themeName), [themeName]);
  useEffect(() => applyLayout(layout), [layout]);

  // Notify when a long turn finishes while the window is in the background.
  const runStartRef = useRef<number | undefined>(undefined);
  const prevStatusRef = useRef(cp.state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const status = cp.state.status;
    if (prev === "idle" && status !== "idle") {
      runStartRef.current = Date.now();
      primeNotifications();
    } else if (prev !== "idle" && status === "idle") {
      const last = [...cp.state.rows].reverse().find((r) => r.kind === "message" && r.msg.role === "assistant");
      const body = last?.kind === "message" ? last.msg.text.slice(0, 140) : "";
      notifyTurnComplete({
        title: cp.state.sessions.find((s) => s.id === cp.state.sessionId)?.title || "CodePilot",
        body: body || t("Ready"),
        startedAt: runStartRef.current,
        onClick: () => window.focus(),
      });
      runStartRef.current = undefined;
    }
    prevStatusRef.current = status;
  }, [cp.state.status, cp.state.rows, cp.state.sessions, cp.state.sessionId]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next, true);
      return next;
    });
  }, []);

  const setThemePersist = useCallback((next: Theme) => {
    applyTheme(next, true);
    setTheme(next);
  }, []);

  const setThemeNamePersist = useCallback((next: ThemeName) => {
    applyThemeName(next, true);
    setThemeName(next);
  }, []);

  const switchLayout = useCallback((next: Layout) => {
    saveLayout(next);
    setLayout(next);
  }, []);

 // ---- connection bootstrap
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const bridge = bridgeRef.current;
    if (bridge) {
      // host/init arrives during connect (in reply to `ready`). Capture cwd +
      // multi-root folders so we bind the IDE workspace after the socket is up.
      let hostCwd = "";
      let hostFolders: string[] = [];
      const clientName = surface.host === "idea" ? "codepilot-idea" : "codepilot-vscode";
      const applyHostWorkspace = async (cwd: string, folderList: string[]): Promise<void> => {
        const next = cwd.trim();
        const folders = folderList.map((f) => f.trim()).filter(Boolean);
        if (folders.length > 0) {
          cpRef.current.seedWorkspaces(folders, { replace: true });
        } else if (next) {
          cpRef.current.seedWorkspaces([next], { replace: true });
        }
        if (!next) return;
        if (sameCwd(next, cpRef.current.state.cwd)) return;
        await cpRef.current.openWorkspace(next);
      };
      bridge.on((msg) => {
        if (msg.type === "host/init") {
          applyHostLocale(msg.locale);
          if (msg.theme) setTheme(msg.theme);
          hostCwd = (msg.cwd || "").trim();
          hostFolders = Array.isArray(msg.folders) ? msg.folders : hostCwd ? [hostCwd] : [];
          if (cpRef.current.state.connection === "connected") {
            void applyHostWorkspace(hostCwd, hostFolders);
          }
        } else if (msg.type === "host/theme") {
          setTheme(msg.theme);
        } else if (msg.type === "host/openSettings") {
          window.dispatchEvent(new Event("codepilot:open-settings"));
        } else if (msg.type === "host/prompt") {
          if (msg.send) void cpRef.current.send(msg.text);
          else setDraft((d) => (d ? `${d}\n\n${msg.text}` : msg.text));
        } else if (msg.type === "host/command") {
          const live = cpRef.current;
          if (msg.name === "new") live.closeSession();
          else if (msg.name === "cancel") void live.cancel();
          else if (msg.name === "mode") void live.setMode(msg.mode);
        }
      });
      void (async () => {
        await cp.connectHost(bridge, hostCwd, clientName);
        if (hostCwd || hostFolders.length) await applyHostWorkspace(hostCwd, hostFolders);
      })();
      return;
    }
    const prefs = loadPrefs();
    const afterConnect = async (p: Promise<void>): Promise<void> => {
      await p;
 // Restore last workspace after connect — never block the connect screen on
 // cwd. The desktop app intentionally opens with no workspace selected so the
 // user picks one explicitly (sessions are scoped per workspace).
      if (surface.desktop) return;
      const last = loadPrefs().cwd;
      if (last) await cpRef.current.openWorkspace(last);
    };
    if (surface.autoConnect) {
 // Persist the link's token immediately so a refresh mid-handshake still
 // reconnects, and so an older saved token is replaced by this serve's.
      const url = surface.autoConnect.url;
      const token = surface.autoConnect.token ?? "";
      savePrefs({
        url,
        token,
        cwd: prefs.cwd,
        workspaces: prefs.workspaces,
      });
      // Remote phone: show EXACTLY the grant-authorized workspaces. Replace
      // (not merge) so stale localStorage-cached workspaces from a prior local
      // session on this browser profile don't leak into the scoped remote view.
      if (surface.remote) cp.seedWorkspaces(surface.remoteCwds ?? [], { replace: true });
      else if (surface.remoteCwds?.length) cp.seedWorkspaces(surface.remoteCwds);
      void afterConnect(cp.connect({ url, token, cwd: surface.autoConnect.cwd || undefined }));
    } else if (prefs.url && prefs.token) {
      void afterConnect(cp.connect({ url: prefs.url, token: prefs.token }));
    }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    (rawPath: string, lineArg?: number) => {
      // A clicked reference may carry a trailing `:line(:col)` (e.g.
      // "src/foo.ts:42"); strip it so the host opens the real file.
      const ref = parseReference(rawPath);
      const path = ref.path;
      const line = lineArg ?? ref.line;
      if (bridgeRef.current) bridgeRef.current.post({ type: "openFile", path, line });
      else void openResolvedPath(cp.client, cp.state.cwd, path);
    },
    [cp.state.cwd],
  );

  // Insert a code snippet at the IDE editor's caret (embedded only; host writes
  // the active editor, never disk). Returns false when no host is present so the
  // caller can fall back to copy.
  const insertIntoEditor = useCallback((text: string): boolean => {
    if (!bridgeRef.current) return false;
    bridgeRef.current.post({ type: "insertText", text });
    return true;
  }, []);

  const common = {
    cp,
    draft,
    setDraft,
    theme,
    toggleTheme,
    setThemePersist,
    themeName,
    setThemeNamePersist,
    layout,
    switchLayout,
  };

  return (
    <>
      {layout === "embedded" ? (
        <EmbeddedLayout {...common} bridge={bridgeRef.current} onOpenFile={openFile} onInsertCode={insertIntoEditor} />
      ) : layout === "agent" ? (
        <AgentLayout {...common} surface={surface} onSwitch={() => switchLayout("web")} />
      ) : (
        <WebLayout {...common} surface={surface} onSwitch={() => switchLayout("agent")} />
      )}
      {/* First-run guide only on the standalone web/desktop surface, not the
          IDE-embedded or remote-paired surfaces (those have their own flows). */}
      {layout !== "embedded" && !surface.remote && (
        <OnboardingGuide
          cp={cp}
          onOpenSettings={() => window.dispatchEvent(new Event("codepilot:open-settings"))}
        />
      )}
      <Toast text={cp.state.notice ? t(cp.state.notice) : undefined} onDone={() => cp.notify(undefined)} />
    </>
  );
}
