import { useEffect, useMemo, useRef, useState } from "react";

import { describeError } from "../protocol/client.js";
import type { Codepilot } from "../state/useCodepilot.js";
import { loadPrefs, sameCwd } from "../prefs.js";
import type { Layout, Surface, Theme, ThemeName } from "../surface.js";
import { t } from "../i18n.js";
import { Transcript } from "../components/Transcript.js";
import {
  Composer,
  ConnectScreen,
  ThemeToggle,
  WorkspaceSessionNav,
  useStickyScroll,
} from "../components/Chrome.js";
import { FilePreview } from "../components/AgentView.js";
import { parseReference } from "../state/paths.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { WorkspacePanel } from "../components/WorkspacePanel.js";
import {
  FolderIcon,
  GitIcon,
  ListIcon,
  LogoMark,
  PanelRightIcon,
  RefreshIcon,
  RocketIcon,
  SidebarIcon,
  SpinnerIcon,
  WrenchIcon,
} from "../components/Icons.js";
import { TrajectoryPanel } from "../components/TrajectoryPanel.js";
import { BrowserPanel } from "../components/BrowserPanel.js";
import { GitPanel } from "../components/GitPanel.js";
import { CommandPalette, type PaletteCommand } from "../components/CommandPalette.js";
import type { LayoutProps } from "./layoutTypes.js";
import { needsConnectScreen, openResolvedPath, pickWorkspaceViaSystem, scrollSignature, shortCwd } from "./helpers.js";
import { useComposer } from "./useComposer.js";
import { ChatEmpty } from "./ChatEmpty.js";
import { ReconnectBanner } from "./ReconnectBanner.js";

export function WebLayout({
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
  surface,
  onSwitch,
}: LayoutProps & { surface: Surface; onSwitch(): void }): React.ReactElement {
  const { state } = cp;
  const prefs = useMemo(loadPrefs, []);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [workspaceMax, setWorkspaceMax] = useState(false);
  const [showTrajectory, setShowTrajectory] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // Desktop in-app browser: links call window.__codepilotOpenBrowser.
  useEffect(() => {
    if (!surface.desktop) return;
    window.__codepilotOpenBrowser = (u: string) => {
      setBrowserUrl(u);
      setShowTrajectory(false);
      setShowWorkspace(false);
      setShowGit(false);
    };
    return () => {
      delete window.__codepilotOpenBrowser;
    };
  }, [surface.desktop]);
  // Native menu commands: "settings" opens the panel; "check-updates" runs
  // the update check directly (via a ref so we see the latest handler).
  const checkUpdateRef = useRef<() => void>(() => {});
  useEffect(() => {
    const api = window.codepilotDesktop;
    if (!api?.onMenu) return;
    return api.onMenu((cmd) => {
      if (cmd === "check-updates") checkUpdateRef.current();
      else setShowSettings(true);
    });
  }, []);
  // The first-run guide (and any surface) can request the Settings panel via a
  // window event, so it doesn't need a direct handle to this layout's state.
  useEffect(() => {
    const open = (): void => setShowSettings(true);
    window.addEventListener("codepilot:open-settings", open);
    return () => window.removeEventListener("codepilot:open-settings", open);
  }, []);
  // Global ⌘K / Ctrl+K toggles the command palette. Registered before any
  // early return so the hook order stays stable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const { setRef: scrollRef, elRef: scrollElRef } = useStickyScroll(
    scrollSignature(state.rows) + (state.permission ? "p" : "") + (state.question ? "q" : ""),
    { sessionKey: state.sessionId, onNearTop: () => void cp.loadOlderHistory() },
  );
  const composer = useComposer(cp, draft, setDraft, t("Ask CodePilot…"));
  const connected = state.connection === "connected";
  const canBootstrap = !!(
    surface.autoConnect?.token ||
    surface.autoConnect?.url ||
    (prefs.url && prefs.token)
  );

  if (needsConnectScreen(cp, canBootstrap)) {
    return (
      <ConnectScreen
        state={state}
        defaultUrl={surface.autoConnect?.url ?? prefs.url}
        defaultToken={prefs.token || surface.autoConnect?.token || ""}
        onConnect={(o) => void cp.connect(o)}
        topRight={<ThemeToggle theme={theme} onToggle={toggleTheme} />}
      />
    );
  }

  const title = state.sessions.find((s) => s.id === state.sessionId)?.title;

  const canPickWorkspace = !surface.remote && cp.client.canPickWorkspace();
  const openNewWorkspace = async (): Promise<void> => {
    if (!canPickWorkspace) return;
    const picked = await pickWorkspaceViaSystem(cp);
    if (picked) await cp.openWorkspace(picked);
  };

  const resumeInWorkspace = async (id: string, cwd: string): Promise<void> => {
    if (!sameCwd(cwd, state.cwd)) await cp.openWorkspace(cwd);
    await cp.resumeSession(id);
  };

  const checkForUpdate = async (): Promise<void> => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const { engine } = await cp.client.checkEngineUpdate();
      if (!engine.available) {
        cp.notify(`${t("You’re up to date")} (${engine.current})`);
      } else if (engine.canAutoApply) {
        const to = engine.latest ?? engine.tag ?? "";
        if (window.confirm(`${t("Update available")}: ${engine.current} → ${to}. ${t("Install now?")}`)) {
          const res = await cp.client.applyEngineUpdate();
          cp.notify(
            res.applied
              ? `${t("Updated to")} ${res.version}. ${t("Restart to use the new engine.")}`
              : res.message || t("Update could not be applied"),
          );
        }
      } else {
        cp.notify(`${t("Update available")}: ${engine.latest ?? engine.tag ?? ""} — ${t("run `codepilot update`")}`);
      }
    } catch (err) {
      cp.notify(describeError(err));
    } finally {
      setCheckingUpdate(false);
    }
  };
  checkUpdateRef.current = () => void checkForUpdate();

  // Build the ⌘K palette commands fresh each render (only the open palette
  // consumes them, so memoization is not worth the hook complexity). This is a
  // plain const — not a hook — so it may live after the early connect-screen
  // return above.
  const paletteCommands: PaletteCommand[] = [];
  {
    const cmds = paletteCommands;
    const act = (id: string, title: string, run: () => void, keywords?: string): void => {
      cmds.push({ id, title, group: t("Actions"), run, keywords });
    };
    act("new-chat", t("New chat / session"), () => {
      if (!state.cwd) {
        cp.notify(t("Select a workspace first, or open a new one."));
        return;
      }
      void cp.newSession();
    });
    if (state.cwd) {
      act("toggle-files", t("Toggle Files panel"), () => {
        setShowWorkspace((v) => !v);
        setWorkspaceMax(false);
        setShowTrajectory(false);
        setShowGit(false);
        setBrowserUrl(null);
      });
      act("toggle-git", t("Toggle Git panel"), () => {
        setShowGit((v) => !v);
        setShowWorkspace(false);
        setShowTrajectory(false);
        setBrowserUrl(null);
      });
    }
    if (state.sessionId) {
      act("toggle-trajectory", t("Toggle Trajectory panel"), () => {
        setShowTrajectory((v) => !v);
        setShowWorkspace(false);
        setShowGit(false);
        setBrowserUrl(null);
      });
    }
    act("settings", t("Settings"), () => setShowSettings(true));
    act("toggle-theme", t("Toggle theme"), () => toggleTheme());
    act("agent-view", t("Switch to Agent view"), () => onSwitch());
    if (connected && !checkingUpdate) {
      act("check-updates", t("Check for updates"), () => void checkForUpdate());
    }
    for (const s of state.sessions) {
      if (s.id === state.sessionId) continue;
      cmds.push({
        id: `session-${s.id}`,
        title: s.title || s.id,
        hint: s.cwd ? shortCwd(s.cwd) : undefined,
        group: t("Resume session"),
        keywords: s.id,
        run: () => void resumeInWorkspace(s.id, s.cwd || state.cwd),
      });
    }
    for (const ws of cp.workspaces) {
      if (sameCwd(ws, state.cwd)) continue;
      cmds.push({
        id: `ws-${ws}`,
        title: shortCwd(ws),
        hint: ws,
        group: t("Open workspace"),
        run: () => void cp.openWorkspace(ws),
      });
    }
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--color-bg)]">
      {showSidebar && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
          {surface.desktop && window.codepilotDesktop?.platform === "darwin" && (
            <div className="h-10 shrink-0 [-webkit-app-region:drag]" />
          )}
          <div className={`flex h-12 shrink-0 items-center gap-2 px-3 ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
            <LogoMark size={24} />
            <span className="text-[13.5px] font-semibold tracking-tight text-[var(--color-ink)]">CodePilot</span>
          </div>

          <WorkspaceSessionNav
            workspaces={cp.workspaces}
            sessions={state.sessions}
            activeCwd={state.cwd}
            activeSessionId={state.sessionId}
            connected={connected}
            newLabel={t("New chat")}
            emptyText={t("No saved sessions yet.")}
            canOpenNewWorkspace={canPickWorkspace}
            onOpenWorkspace={(ws) => void cp.openWorkspace(ws)}
            onCloseWorkspace={(ws) => void cp.closeWorkspace(ws)}
            onOpenNewWorkspace={() => void openNewWorkspace()}
            onNewSession={() => {
              if (!state.cwd) {
                cp.notify(t("Select a workspace first, or open a new one."));
                return;
              }
              void cp.newSession();
            }}
            onResumeSession={(id, cwd) => void resumeInWorkspace(id, cwd)}
            onPinSession={(id, pinned) => void cp.pinSession(id, pinned)}
            onArchiveSession={(id, archived) => void cp.archiveSession(id, archived)}
            canFork={!!state.sessionId}
            onFork={() => void cp.forkSession()}
            onRefresh={() => void cp.refreshSessions()}
          />
          <div className="flex items-center gap-1 border-t border-[var(--color-edge-subtle)] px-3 py-2">
            <button
              type="button"
              className="cp-btn-ghost flex items-center gap-1 py-1 text-[11.5px]"
              onClick={() => setShowSettings(true)}
              disabled={!connected}
              title={t("Settings")}
            >
              <WrenchIcon className="h-3.5 w-3.5" />
              {t("Settings")}
            </button>
            <div className="ml-auto flex items-center">
              <button type="button" className="cp-icon-btn" onClick={onSwitch} title={t("Agent view")}>
                <RocketIcon className="h-4 w-4" />
              </button>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
            </div>
          </div>
        </aside>
      )}

      <main className={`min-w-0 flex-1 flex-col bg-[var(--color-bg)] ${workspaceMax && showWorkspace && state.cwd ? "hidden" : "flex"}`}>
        {!showSidebar && surface.desktop && window.codepilotDesktop?.platform === "darwin" && (
          <div className="h-10 shrink-0 [-webkit-app-region:drag]" />
        )}
        <header className={`flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3 ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
          <button type="button" className="cp-icon-btn [-webkit-app-region:no-drag]" onClick={() => setShowSidebar((v) => !v)} title={t("Sessions")}>
            <SidebarIcon className="h-4 w-4" />
          </button>
          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-ink)]">
            {title || (state.sessionId ? state.sessionId : t("New chat"))}
          </span>
          {state.cwd && (
            <span className="cp-chip hidden max-w-64 truncate md:inline-flex" title={state.cwd}>
              <FolderIcon className="h-3 w-3" />
              {state.cwd}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5 [-webkit-app-region:no-drag]">
            <button
              type="button"
              className="cp-icon-btn"
              onClick={() => void checkForUpdate()}
              title={t("Check for updates")}
              disabled={!connected || checkingUpdate}
            >
              {checkingUpdate ? <SpinnerIcon className="h-4 w-4" /> : <RefreshIcon className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className="cp-icon-btn"
              aria-pressed={showTrajectory}
              onClick={() => {
                setShowTrajectory((v) => !v);
                setShowWorkspace(false);
                setShowGit(false);
                setBrowserUrl(null);
              }}
              title={t("Trajectory")}
              disabled={!state.sessionId}
            >
              <ListIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="cp-icon-btn"
              aria-pressed={showGit}
              onClick={() => {
                setShowGit((v) => !v);
                setShowWorkspace(false);
                setShowTrajectory(false);
                setBrowserUrl(null);
              }}
              title={t("Git")}
              disabled={!state.cwd}
            >
              <GitIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="cp-icon-btn"
              aria-pressed={showWorkspace}
              onClick={() => {
                setShowWorkspace((v) => !v);
                setWorkspaceMax(false);
                setShowTrajectory(false);
                setShowGit(false);
                setBrowserUrl(null);
              }}
              title={t("Files")}
              disabled={!state.cwd}
            >
              <PanelRightIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="cp-icon-btn"
              onClick={() => setShowSettings(true)}
              title={t("Settings")}
              disabled={!connected}
            >
              <WrenchIcon className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div
          key={state.sessionId ?? "none"}
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="mx-auto w-full max-w-3xl px-5 py-6">
            {state.rows.length === 0 && !state.permission && !state.question && state.status === "idle" ? (
              <ChatEmpty
                hasSession={!!state.sessionId}
                hasWorkspace={!!state.cwd}
                canOpenWorkspace={canPickWorkspace}
                onOpenWorkspace={() => void openNewWorkspace()}
                onPick={(p) => setDraft(p)}
              />
            ) : (
              <Transcript
                rows={state.rows}
                subagents={state.subagents}
                sessionId={state.sessionId}
                scrollContainerRef={scrollElRef}
                status={state.status}
                activity={state.activity}
                plan={state.plan}
                permission={state.permission}
                question={state.question}
                onDecide={(d) => void cp.decidePermission(d)}
                onAnswer={(a) => void cp.answerQuestion(a)}
                onRetry={() => void cp.retryLast()}
                onOpenPath={(p) => setPreview(parseReference(p).path)}
              />
            )}
          </div>
        </div>

        <div className="shrink-0 px-5 pb-4">
          <div data-cp-composer className="mx-auto w-full max-w-3xl">
            <ReconnectBanner cp={cp} />
            <Composer {...composer} />
          </div>
        </div>
      </main>

      {connected && showTrajectory && state.sessionId && (
        <TrajectoryPanel
          rows={state.rows}
          sessionId={state.sessionId}
          usage={state.usage}
          onClose={() => setShowTrajectory(false)}
          onOpenPath={(p) => setPreview(parseReference(p).path)}
        />
      )}
      {connected && showWorkspace && state.cwd && (
        <WorkspacePanel
          client={cp.client}
          cwd={state.cwd}
          connected={connected}
          rows={state.rows}
          maximized={workspaceMax}
          onToggleMaximize={() => setWorkspaceMax((v) => !v)}
          onClose={() => {
            setShowWorkspace(false);
            setWorkspaceMax(false);
          }}
        />
      )}
      {connected && showGit && state.cwd && (
        <GitPanel client={cp.client} cwd={state.cwd} sessionId={state.sessionId} onClose={() => setShowGit(false)} />
      )}
      {browserUrl && (
        <BrowserPanel
          url={browserUrl}
          onClose={() => setBrowserUrl(null)}
          onOpenExternally={
            window.codepilotDesktop ? (u) => window.open(u, "_blank", "noopener,noreferrer") : undefined
          }
        />
      )}
      {preview && (
        <FilePreview
          client={cp.client}
          path={preview}
          cwd={state.cwd}
          onClose={() => setPreview(null)}
          onOpenExternally={
            window.codepilotDesktop
              ? (p) => void openResolvedPath(cp.client, state.cwd, p)
              : undefined
          }
        />
      )}
      <SettingsPanel
        cp={cp}
        open={showSettings}
        onClose={() => setShowSettings(false)}
        theme={theme}
        onTheme={setThemePersist}
        themeName={themeName}
        onThemeName={setThemeNamePersist}
        layout={layout}
        onLayout={switchLayout}
        onComposePrompt={(text) => {
          setDraft(text);
          setShowSettings(false);
        }}
      />
      {showPalette && <CommandPalette commands={paletteCommands} onClose={() => setShowPalette(false)} />}
    </div>
  );
}
