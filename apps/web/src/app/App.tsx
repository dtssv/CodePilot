import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PanelPosition } from "../components/settings/GeneralSection.js";
import { HostBridge, type HostUiPrefs } from "../protocol/bridge.js";
import { useCodepilot } from "../state/useCodepilot.js";
import {
  mergeRefsIntoPrompt,
  newComposerRef,
} from "../state/composerRefs.js";
import {
  loadPrefs,
  saveEndpointPref,
  savePrefs,
  sameCwd,
  setEndpointPrefSink,
} from "../prefs.js";
import {
  applyLayout,
  applyTheme,
  applyThemeName,
  detectSurface,
  detectSystemTheme,
  initialThemeName,
  initialThemePreference,
  resolveTheme,
  saveLayout,
  saveThemePreference,
  type Layout,
  type Surface,
  type Theme,
  type ThemeName,
  type ThemePreference,
  THEME_NAMES,
} from "../surface.js";
import {
  applyHostLocale,
  getLocale,
  hasSavedLocale,
  setLocale,
  t,
  useLocale,
  type Locale,
} from "../i18n.js";
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
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    initialThemePreference(surface.host),
  );
  const hostThemeRef = useRef<Theme | undefined>(undefined);
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(initialThemePreference(surface.host), surface.host),
  );
  const [themeName, setThemeName] = useState<ThemeName>(initialThemeName);
  const [panelPosition, setPanelPositionState] = useState<PanelPosition>("left");
  const cp = useCodepilot();
  const cpRef = useRef(cp);
  cpRef.current = cp;
  const [draft, setDraft] = useState("");
  const bridgeRef = useRef<HostBridge | null>(null);
  if (surface.host && bridgeRef.current === null) bridgeRef.current = new HostBridge(surface.host);
  const themePreferenceRef = useRef(themePreference);
  themePreferenceRef.current = themePreference;

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => applyThemeName(themeName), [themeName]);
  useEffect(() => applyLayout(layout), [layout]);

  // OS prefers-color-scheme when preference is system and not inside an IDE host.
  useEffect(() => {
    if (themePreference !== "system" || surface.host) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => setTheme(mq.matches ? "dark" : "light");
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themePreference, surface.host]);

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

  /** Skip mirroring prefs we just applied from the host (avoids echo loops). */
  const suppressHostPrefsEcho = useRef(false);

  const pushHostPrefs = useCallback((prefs: HostUiPrefs) => {
    if (suppressHostPrefsEcho.current) return;
    bridgeRef.current?.post({ type: "prefs/set", prefs });
  }, []);

  const applyThemeChoice = useCallback(
    (preference: ThemePreference, hostTheme?: Theme) => {
      saveThemePreference(preference);
      setThemePreference(preference);
      const resolved = resolveTheme(
        preference,
        surface.host,
        hostTheme ?? hostThemeRef.current,
      );
      applyTheme(resolved);
      setTheme(resolved);
    },
    [surface.host],
  );

  const applySharedPrefs = useCallback(
    (prefs: HostUiPrefs | undefined) => {
      if (!prefs) return;
      suppressHostPrefsEcho.current = true;
      try {
        if (prefs.theme === "light" || prefs.theme === "dark" || prefs.theme === "system") {
          applyThemeChoice(prefs.theme);
        }
        if (prefs.themeName && (THEME_NAMES as readonly string[]).includes(prefs.themeName)) {
          const name = prefs.themeName as ThemeName;
          applyThemeName(name, true);
          setThemeName(name);
        }
        if (prefs.locale === "zh" || prefs.locale === "en") {
          setLocale(prefs.locale, { persist: true });
        }
        if (
          prefs.panelPosition === "left" ||
          prefs.panelPosition === "right" ||
          prefs.panelPosition === "top" ||
          prefs.panelPosition === "bottom"
        ) {
          setPanelPositionState(prefs.panelPosition);
        }
        if (prefs.endpoint?.model) {
          // Writes localStorage only; applyHostWorkspace / newSession read it back.
          saveEndpointPref(prefs.endpoint.cwd, {
            model: prefs.endpoint.model,
            providerId: prefs.endpoint.providerId || "_active",
          });
        }
      } finally {
        suppressHostPrefsEcho.current = false;
      }
    },
    [applyThemeChoice],
  );

  const toggleTheme = useCallback(() => {
    const order: ThemePreference[] = ["light", "dark", "system"];
    const idx = order.indexOf(themePreferenceRef.current);
    const next = order[(idx + 1) % order.length]!;
    applyThemeChoice(next);
    pushHostPrefs({ theme: next });
  }, [applyThemeChoice, pushHostPrefs]);

  const setThemePersist = useCallback(
    (next: ThemePreference) => {
      applyThemeChoice(next);
      pushHostPrefs({ theme: next });
    },
    [applyThemeChoice, pushHostPrefs],
  );

  const setThemeNamePersist = useCallback(
    (next: ThemeName) => {
      applyThemeName(next, true);
      setThemeName(next);
      pushHostPrefs({ themeName: next });
    },
    [pushHostPrefs],
  );

  const setLocalePersist = useCallback(
    (next: Locale) => {
      setLocale(next, { persist: true });
      pushHostPrefs({ locale: next });
    },
    [pushHostPrefs],
  );

  const setPanelPositionPersist = useCallback(
    (next: PanelPosition) => {
      setPanelPositionState(next);
      pushHostPrefs({ panelPosition: next });
    },
    [pushHostPrefs],
  );

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
      // Mirror last-used model into the extension host (shared by Settings + chat).
      setEndpointPrefSink((cwd, pref) => {
        if (suppressHostPrefsEcho.current) return;
        bridge.post({
          type: "prefs/set",
          prefs: { endpoint: { ...pref, cwd: cwd || undefined } },
        });
      });
      const applyHostWorkspace = async (cwd: string, folderList: string[]): Promise<void> => {
        const next = cwd.trim();
        const folders = folderList.map((f) => f.trim()).filter(Boolean);
        if (folders.length > 0) {
          cpRef.current.seedWorkspaces(folders, { replace: true });
        } else if (next) {
          cpRef.current.seedWorkspaces([next], { replace: true });
        }
        if (!next) return;
        // connectHost may already have set cwd — still restore sticky model.
        if (sameCwd(next, cpRef.current.state.cwd)) {
          if (!cpRef.current.state.model) await cpRef.current.applyPreferredModel(next);
          return;
        }
        await cpRef.current.openWorkspace(next);
      };
      bridge.on((msg) => {
        if (msg.type === "host/init") {
          if (msg.theme === "light" || msg.theme === "dark") {
            hostThemeRef.current = msg.theme;
          }
          // Shared prefs (incl. locale) first — dock switches remount the chat
          // webview with empty localStorage; restoring from host SoT must win
          // before falling back to the IDE chrome language.
          if (msg.prefs) applySharedPrefs(msg.prefs);
          else if (themePreferenceRef.current === "system" && msg.theme) {
            setTheme(detectSystemTheme(surface.host, msg.theme));
          }
          if (!hasSavedLocale()) applyHostLocale(msg.locale);
          // Publish this webview's saved locale into host globalState so a later
          // dock remount (new webview / empty localStorage) can restore it.
          if (hasSavedLocale()) pushHostPrefs({ locale: getLocale() });
          hostCwd = (msg.cwd || "").trim();
          hostFolders = Array.isArray(msg.folders) ? msg.folders : hostCwd ? [hostCwd] : [];
          if (cpRef.current.state.connection === "connected") {
            void applyHostWorkspace(hostCwd, hostFolders);
          }
        } else if (msg.type === "host/theme") {
          hostThemeRef.current = msg.theme;
          // Only track IDE chrome when this client chose "system".
          if (themePreferenceRef.current === "system") setTheme(msg.theme);
        } else if (msg.type === "host/prefs") {
          applySharedPrefs(msg.prefs);
          // Sibling webview updated last-used model — refresh picker if empty.
          if (msg.prefs.endpoint?.model && cpRef.current.state.connection === "connected") {
            const cwd = cpRef.current.state.cwd;
            if (cwd && !cpRef.current.state.model) void cpRef.current.applyPreferredModel(cwd);
          }
        } else if (msg.type === "host/openSettings") {
          // Always open the in-webview sheet in THIS panel. Do not reuse
          // `codepilot:open-settings` — in the chat sidebar that event asks the
          // host for a wide Settings panel, which would loop / never show the
          // sheet when this webview is already the Settings surface.
          // Capability sections open FeatureDialog; Settings keeps general/models/plugins.
          const section = msg.section;
          if (
            section === "connectors" ||
            section === "custom-mcp" ||
            section === "skills" ||
            section === "remote" ||
            section === "schedule"
          ) {
            window.dispatchEvent(
              new CustomEvent("codepilot:open-feature", { detail: { section } }),
            );
          } else if (section) {
            window.dispatchEvent(
              new CustomEvent("codepilot:settings-nav", { detail: { section } }),
            );
            window.dispatchEvent(new Event("codepilot:show-settings-sheet"));
          } else {
            window.dispatchEvent(new Event("codepilot:show-settings-sheet"));
          }
        } else if (msg.type === "host/prompt") {
          const refs = (msg.refs ?? [])
            .filter((r) => !!r.path)
            .map((r) => newComposerRef({ path: r.path, startLine: r.startLine, endLine: r.endLine }));
          const body = (msg.text ?? "").trim();
          if (msg.send) {
            const text = mergeRefsIntoPrompt(body, refs);
            if (text.trim()) void cpRef.current.send(text);
          } else {
            for (const r of refs) {
              window.dispatchEvent(
                new CustomEvent("codepilot:add-ref", {
                  detail: { path: r.path, startLine: r.startLine, endLine: r.endLine },
                }),
              );
            }
            if (body) setDraft((d) => (d ? `${d}\n\n${body}` : body));
          }
        } else if (msg.type === "host/command") {
          const live = cpRef.current;
          // Match the sidebar Plus button: pin last-used model into a new session.
          if (msg.name === "new") void live.newSession();
          else if (msg.name === "cancel") void live.cancel();
          else if (msg.name === "mode") void live.setMode(msg.mode);
        }
      });
      void (async () => {
        await cp.connectHost(bridge, hostCwd, clientName);
        if (hostCwd || hostFolders.length) await applyHostWorkspace(hostCwd, hostFolders);
      })();
      return () => setEndpointPrefSink(undefined);
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
    themePreference,
    toggleTheme,
    setThemePersist,
    themeName,
    setThemeNamePersist,
    setLocalePersist,
    panelPosition,
    setPanelPosition: setPanelPositionPersist,
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
