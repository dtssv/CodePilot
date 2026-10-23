import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HostBridge } from "./protocol/bridge.js";
import { useCodepilot, type Codepilot } from "./state/useCodepilot.js";
import type { Row } from "./state/rows.js";
import type { ImageAttachment, PromptFile } from "@codepilot/core";
import { loadPrefs, savePrefs, sameCwd } from "./prefs.js";
import {
  applyLayout,
  applyTheme,
  detectSurface,
  initialTheme,
  saveLayout,
  type Layout,
  type Surface,
  type Theme,
} from "./surface.js";
import { setLocale, t } from "./i18n.js";
import { Transcript } from "./components/Transcript.js";
import {
  Composer,
  ConnectionPill,
  ConnectScreen,
  SessionList,
  ThemeToggle,
  Toast,
  UsageLine,
  WorkspaceSessionNav,
  useStickyScroll,
} from "./components/Chrome.js";
import { AgentHome, FilePreview, TaskPanel } from "./components/AgentView.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { WorkspacePanel } from "./components/WorkspacePanel.js";
import {
  AlertIcon,
  ChatIcon,
  CodeIcon,
  FolderIcon,
  ListIcon,
  LogoMark,
  PanelRightIcon,
  PlusIcon,
  RefreshIcon,
  RocketIcon,
  SidebarIcon,
  SpinnerIcon,
  WrenchIcon,
} from "./components/Icons.js";
import { TrajectoryPanel } from "./components/TrajectoryPanel.js";

declare global {
  interface Window {
 /** Preload API of the desktop (Electron) agent app. */
    codepilotDesktop?: {
      platform: string;
      pickFolder(): Promise<string | null>;
      openPath(path: string): void;
    };
  }
}

/** System folder dialog only — no in-app browse modal. */
async function pickWorkspaceViaSystem(cp: Codepilot): Promise<string | null> {
  if (window.codepilotDesktop) {
    return window.codepilotDesktop.pickFolder();
  }
  try {
    const result = await cp.client.pickFolder();
    if (result.path) return result.path;
    if (!result.supported) {
      cp.notify(t("System folder picker is not available on this host"));
    }
    return null;
  } catch (err) {
    cp.notify(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function App(): React.ReactElement {
  const surface = useMemo<Surface>(detectSurface, []);
  const [layout, setLayout] = useState<Layout>(surface.layout);
  const [theme, setTheme] = useState<Theme>(() => initialTheme(surface.host));
  const cp = useCodepilot();
  const cpRef = useRef(cp);
  cpRef.current = cp;
  const [draft, setDraft] = useState("");
  const bridgeRef = useRef<HostBridge | null>(null);
  if (surface.host && bridgeRef.current === null) bridgeRef.current = new HostBridge(surface.host);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => applyLayout(layout), [layout]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next, true);
      return next;
    });
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
      bridge.on((msg) => {
        if (msg.type === "host/init") {
          setLocale(msg.locale);
          if (msg.theme) setTheme(msg.theme);
        } else if (msg.type === "host/theme") {
          setTheme(msg.theme);
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
      void cp.connectHost(bridge, "", surface.host === "idea" ? "codepilot-idea" : "codepilot-vscode");
      return;
    }
    const prefs = loadPrefs();
    const afterConnect = async (p: Promise<void>): Promise<void> => {
      await p;
 // Restore last workspace after connect — never block the connect screen on cwd.
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
      void afterConnect(cp.connect({ url, token, cwd: surface.autoConnect.cwd || undefined }));
    } else if (prefs.url && prefs.token) {
      void afterConnect(cp.connect({ url: prefs.url, token: prefs.token }));
    }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    (path: string) => {
      if (bridgeRef.current) bridgeRef.current.post({ type: "openFile", path });
      else window.codepilotDesktop?.openPath(joinPath(cp.state.cwd, path));
    },
    [cp.state.cwd],
  );

  const common = { cp, draft, setDraft, theme, toggleTheme };

  return (
    <>
      {layout === "embedded" ? (
        <EmbeddedLayout {...common} bridge={bridgeRef.current} onOpenFile={openFile} />
      ) : layout === "agent" ? (
        <AgentLayout {...common} surface={surface} onSwitch={() => switchLayout("web")} />
      ) : (
        <WebLayout {...common} surface={surface} onSwitch={() => switchLayout("agent")} />
      )}
      <Toast text={cp.state.notice} onDone={() => cp.notify(undefined)} />
    </>
  );
}

interface LayoutProps {
  cp: Codepilot;
  draft: string;
  setDraft(v: string): void;
  theme: Theme;
  toggleTheme(): void;
}

function useComposer(cp: Codepilot, draft: string, setDraft: (v: string) => void, placeholder?: string) {
  const { state } = cp;
  const busy = state.status !== "idle";
  return {
    value: draft,
    onChange: setDraft,
    onSend: (
      text: string,
      images?: ImageAttachment[],
      files?: PromptFile[],
      delivery?: "auto" | "queue" | "steer",
    ) => cp.send(text, images, files, delivery),
    onStop: () => void cp.cancel(),
    busy,
    disabled: state.connection !== "connected",
    placeholder:
      state.connection !== "connected" ? t("Connect and open a session to start…") : placeholder,
    mode: state.agentMode,
    modes: cp.client.modes,
    onMode: (m: typeof state.agentMode) => void cp.setMode(m),
    followUps: state.followUps,
    onRemoveFollowUp: (id: string) => void cp.removeFollowUp(id),
    onEditFollowUp: (id: string) => {
      const fu = state.followUps?.find((x) => x.id === id);
      if (!fu) return;
      void cp.removeFollowUp(id);
      setDraft(fu.text);
    },
    onSendFollowUpNow: (id: string) => cp.sendFollowUpNow(id),
    footer: (
      <span className="flex flex-wrap items-center gap-2">
        <ModelPicker cp={cp} />
        <UsageLine state={state} />
      </span>
    ),
  };
}

function scrollSignature(rows: Row[]): string {
  const last = rows[rows.length - 1];
  const tail = last?.kind === "message" ? last.msg.text.length : last?.kind === "tool" ? last.tool.status : "";
  return `${rows.length}:${tail}`;
}

/** Full-page connect form only when we have nothing to try with. A URL with
 * `?token=` (or a remembered url+token) skips straight into the main shell
 * while the handshake runs; a failed / stale token just shows the notice
 * there — open the new serve link to replace it. */
function needsConnectScreen(cp: Codepilot, canBootstrap: boolean): boolean {
  const s = cp.state;
  if (s.connection === "connected" || s.connection === "connecting") return false;
  if (s.reconnectAttempt !== undefined) return false;
  if (canBootstrap) return false;
  return true;
}

// ======================================================================
// Web: the browser client — sessions, transcript, workspace.

function WebLayout({
  cp,
  draft,
  setDraft,
  theme,
  toggleTheme,
  surface,
  onSwitch,
}: LayoutProps & { surface: Surface; onSwitch(): void }): React.ReactElement {
  const { state } = cp;
  const prefs = useMemo(loadPrefs, []);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showWorkspace, setShowWorkspace] = useState(true);
  const [showTrajectory, setShowTrajectory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const scrollRef = useStickyScroll(scrollSignature(state.rows) + (state.permission ? "p" : "") + (state.question ? "q" : ""));
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

  const openNewWorkspace = async (): Promise<void> => {
    const picked = await pickWorkspaceViaSystem(cp);
    if (picked) await cp.openWorkspace(picked);
  };

  const resumeInWorkspace = async (id: string, cwd: string): Promise<void> => {
    if (!sameCwd(cwd, state.cwd)) await cp.openWorkspace(cwd);
    await cp.resumeSession(id);
  };

  return (
    <div className="flex h-full bg-[var(--color-bg)]">
      {showSidebar && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
          <div className="flex h-12 shrink-0 items-center gap-2 px-3">
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
            onOpenWorkspace={(ws) => void cp.openWorkspace(ws)}
            onCloseWorkspace={(ws) => void cp.closeWorkspace(ws)}
            onOpenNewWorkspace={() => void openNewWorkspace()}
            onNewSession={() => void cp.newSession()}
            onResumeSession={(id, cwd) => void resumeInWorkspace(id, cwd)}
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
              <ConnectionPill state={state} />
              <button type="button" className="cp-icon-btn" onClick={onSwitch} title={t("Agent view")}>
                <RocketIcon className="h-4 w-4" />
              </button>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
            </div>
          </div>
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-bg)]">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3">
          <button type="button" className="cp-icon-btn" onClick={() => setShowSidebar((v) => !v)} title={t("Sessions")}>
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
          <div className="ml-auto flex items-center gap-1.5">
            {!showSidebar && <ConnectionPill state={state} />}
            <button
              type="button"
              className="cp-icon-btn"
              aria-pressed={showTrajectory}
              onClick={() => setShowTrajectory((v) => !v)}
              title={t("Trajectory")}
              disabled={!state.sessionId}
            >
              <ListIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="cp-icon-btn"
              aria-pressed={showWorkspace}
              onClick={() => setShowWorkspace((v) => !v)}
              title={t("Files")}
              disabled={!state.cwd}
            >
              <PanelRightIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => void cp.disconnect()} className="cp-btn-ghost py-1">
              Disconnect
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-3xl px-5 py-6">
            {state.rows.length === 0 && !state.permission && !state.question && state.status === "idle" ? (
              <ChatEmpty
                hasSession={!!state.sessionId}
                hasWorkspace={!!state.cwd}
                onOpenWorkspace={() => void openNewWorkspace()}
                onPick={(p) => setDraft(p)}
              />
            ) : (
              <Transcript
                rows={state.rows}
                subagents={state.subagents}
                status={state.status}
                activity={state.activity}
                permission={state.permission}
                question={state.question}
                onDecide={(d) => void cp.decidePermission(d)}
                onAnswer={(a) => void cp.answerQuestion(a)}
                onRetry={() => void cp.retryLast()}
              />
            )}
          </div>
        </div>

        <div className="shrink-0 px-5 pb-4">
          <div className="mx-auto w-full max-w-3xl">
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
        />
      )}
      {connected && showWorkspace && state.cwd && (
        <WorkspacePanel client={cp.client} cwd={state.cwd} connected={connected} rows={state.rows} />
      )}
      <SettingsPanel cp={cp} open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

const CHAT_SUGGESTIONS = [
  "Explain the architecture of this project",
  "Find potential bugs in the recent changes",
  "Write unit tests for the most complex module",
];

function ChatEmpty({
  hasSession,
  hasWorkspace,
  onOpenWorkspace,
  onPick,
}: {
  hasSession: boolean;
  hasWorkspace: boolean;
  onOpenWorkspace(): void;
  onPick(p: string): void;
}): React.ReactElement {
  if (!hasWorkspace) {
    return (
      <div className="mt-[12vh] flex flex-col items-center text-center">
        <FolderIcon className="mb-4 h-12 w-12 text-[var(--color-accent)]" />
        <div className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
          {t("Open a workspace")}
        </div>
        <div className="mt-1.5 max-w-sm text-[13px] leading-5 text-[var(--color-ink-dim)]">
          {t("Sessions are tied to a workspace. Open one or more from the sidebar.")}
        </div>
        <button type="button" className="cp-btn-primary mt-6" onClick={onOpenWorkspace}>
          <FolderIcon className="h-3.5 w-3.5" />
          {t("Open workspace…")}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-[12vh] flex flex-col items-center text-center">
      <LogoMark size={48} className="mb-4 drop-shadow-[0_8px_24px_rgba(109,91,246,0.35)]" />
      <div className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">CodePilot</div>
      <div className="mt-1.5 max-w-sm text-[13px] leading-5 text-[var(--color-ink-dim)]">
        {hasSession ? t("Ask anything about your code. Mention files with @path.") : t("Start a new session or resume one from the sidebar.")}
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {CHAT_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(t(s))}
            className="rounded-full border border-[var(--color-edge-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-[12px] text-[var(--color-ink-dim)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
          >
            {t(s)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReconnectBanner({ cp }: { cp: Codepilot }): React.ReactElement | null {
  const s = cp.state;
  if (s.connection === "connected" || s.reconnectAttempt === undefined) return null;
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg bg-[var(--color-warn-dim)] px-3 py-1.5 text-[12px] text-[var(--color-warn)]">
      <SpinnerIcon className="h-3.5 w-3.5" />
      {t("reconnecting")} ({s.reconnectAttempt})…
      {s.connectionError && <span className="truncate opacity-75">{s.connectionError}</span>}
    </div>
  );
}

// ======================================================================
// Agent: task-oriented agent UI — describe a task, watch it get done.

function AgentLayout({
  cp,
  draft,
  setDraft,
  theme,
  toggleTheme,
  surface,
  onSwitch,
}: LayoutProps & { surface: Surface; onSwitch(): void }): React.ReactElement {
  const { state } = cp;
  const prefs = useMemo(loadPrefs, []);
  const [preview, setPreview] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const scrollRef = useStickyScroll(scrollSignature(state.rows) + (state.permission ? "p" : "") + (state.question ? "q" : ""));
  const connected = state.connection === "connected";
  const inTask = !!state.sessionId;

  const homeComposer = {
    ...useComposer(cp, draft, setDraft, t("Describe a task for CodePilot…")),
    onSend: (text: string, images?: ImageAttachment[], files?: PromptFile[]) =>
      cp.startTask(text, state.agentMode, images, files),
  };
  const taskComposer = useComposer(cp, draft, setDraft, t("Ask CodePilot…"));
  const canBootstrap = !!(surface.autoConnect?.token || surface.autoConnect?.url || (prefs.url && prefs.token));

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

  const openNewWorkspace = async (): Promise<void> => {
    const picked = await pickWorkspaceViaSystem(cp);
    if (picked) await cp.openWorkspace(picked);
  };

  const resumeInWorkspace = async (id: string, cwd: string): Promise<void> => {
    if (!sameCwd(cwd, state.cwd)) await cp.openWorkspace(cwd);
    await cp.resumeSession(id);
  };

  const taskTitle =
    state.sessions.find((s) => s.id === state.sessionId)?.title ||
    state.rows.find((r): r is Extract<Row, { kind: "message" }> => r.kind === "message" && r.msg.role === "user")?.msg.text ||
    t("New task");

  return (
    <div className="flex h-full bg-[var(--color-bg)]">
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
        {window.codepilotDesktop?.platform === "darwin" && <div className="h-7 shrink-0 [-webkit-app-region:drag]" />}
        <div className={`flex h-14 shrink-0 items-center gap-2.5 px-4 ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
          <LogoMark size={26} />
          <div className="leading-tight">
            <div className="text-[13.5px] font-semibold tracking-tight text-[var(--color-ink)]">CodePilot</div>
            <div className="text-[10.5px] text-[var(--color-ink-faint)]">{t("Agent")}</div>
          </div>
        </div>
        <WorkspaceSessionNav
          workspaces={cp.workspaces}
          sessions={state.sessions}
          activeCwd={state.cwd}
          activeSessionId={state.sessionId}
          connected={connected}
          newLabel={t("New task")}
          emptyText={t("No tasks yet.")}
          sessionIcon={<RocketIcon className="h-3.5 w-3.5" />}
          onOpenWorkspace={(ws) => void cp.openWorkspace(ws)}
          onCloseWorkspace={(ws) => void cp.closeWorkspace(ws)}
          onOpenNewWorkspace={() => void openNewWorkspace()}
          onNewSession={() => cp.closeSession()}
          onResumeSession={(id, cwd) => void resumeInWorkspace(id, cwd)}
          canFork={!!state.sessionId}
          onFork={() => void cp.forkSession()}
          onRefresh={() => void cp.refreshSessions()}
        />
        <div className="flex items-center gap-1 border-t border-[var(--color-edge-subtle)] px-3 py-2">
          <button
            type="button"
            className="cp-btn-ghost flex items-center gap-1 py-1 text-[11.5px]"
            onClick={() => setShowSettings(true)}
            title={t("Settings")}
            disabled={!connected}
          >
            <WrenchIcon className="h-3.5 w-3.5" />
            {t("Settings")}
          </button>
          <div className="ml-auto flex items-center">
            <ConnectionPill state={state} />
            <button type="button" className="cp-icon-btn" onClick={onSwitch} title={t("Code view")}>
              <CodeIcon className="h-4 w-4" />
            </button>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {window.codepilotDesktop?.platform === "darwin" && <div className="h-7 shrink-0 [-webkit-app-region:drag]" />}
        {inTask ? (
          <>
            <header className={`flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-edge-subtle)] px-5 ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
              <span className="min-w-0 truncate text-[14px] font-semibold text-[var(--color-ink)]">{taskTitle}</span>
              <TaskStatusChip cp={cp} />
              <div className="ml-auto flex items-center gap-1.5 [-webkit-app-region:no-drag]">
                <button type="button" className="cp-btn-ghost py-1" onClick={() => cp.closeSession()}>
                  <PlusIcon className="h-3 w-3" />
                  {t("New task")}
                </button>
              </div>
            </header>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-3xl px-6 py-6">
                <Transcript
                  rows={state.rows}
                  subagents={state.subagents}
                  status={state.status}
                  activity={state.activity}
                  permission={state.permission}
                  question={state.question}
                  planInline={false}
                  onDecide={(d) => void cp.decidePermission(d)}
                  onAnswer={(a) => void cp.answerQuestion(a)}
                  onRetry={() => void cp.retryLast()}
                />
              </div>
            </div>
            <div className="shrink-0 px-6 pb-5">
              <div className="mx-auto w-full max-w-3xl">
                <ReconnectBanner cp={cp} />
                <Composer {...taskComposer} />
              </div>
            </div>
          </>
        ) : (
          <div className={`min-h-0 flex-1 overflow-auto ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
            <div className="[-webkit-app-region:no-drag]">
              <AgentHome
                composer={homeComposer}
                cwd={state.cwd}
                onPickTemplate={(p) => setDraft(p)}
              />
            </div>
          </div>
        )}
      </main>

      {inTask && <TaskPanel state={state} onOpenFile={(p) => setPreview(p)} />}
      {preview && (
        <FilePreview
          client={cp.client}
          path={preview}
          onClose={() => setPreview(null)}
          onOpenExternally={window.codepilotDesktop ? (p) => window.codepilotDesktop?.openPath(joinPath(state.cwd, p)) : undefined}
        />
      )}
      <SettingsPanel cp={cp} open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

function TaskStatusChip({ cp }: { cp: Codepilot }): React.ReactElement {
  const s = cp.state;
  const last = [...s.rows].reverse().find((r) => r.kind !== "usage");
  const failed = s.status === "idle" && last?.kind === "error";
  const [label, tone] =
    s.status === "waiting_permission"
      ? [t("Waiting for approval"), "bg-[var(--color-warn-dim)] text-[var(--color-warn)]"]
      : s.status === "waiting_question"
        ? [t("Waiting for your answer"), "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"]
        : s.status !== "idle"
          ? [t("Working"), "bg-[var(--color-accent-dim)] text-[var(--color-accent)]"]
          : failed
            ? [t("failed"), "bg-[var(--color-remove-dim)] text-[var(--color-remove)]"]
            : s.rows.length > 0
              ? [t("done"), "bg-[var(--color-add-dim)] text-[var(--color-add)]"]
              : [t("Ready"), "bg-[var(--color-surface-hover)] text-[var(--color-ink-dim)]"];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {s.status !== "idle" && <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-current" />}
      {label}
    </span>
  );
}

// ======================================================================
// Embedded: IDE sidebar (VSCode / IntelliJ). Compact, follows IDE theme.

function EmbeddedLayout({
  cp,
  draft,
  setDraft,
  bridge,
  onOpenFile,
}: LayoutProps & { bridge: HostBridge | null; onOpenFile(path: string): void }): React.ReactElement {
  const { state } = cp;
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useStickyScroll(scrollSignature(state.rows) + (state.permission ? "p" : "") + (state.question ? "q" : ""));
  const composer = useComposer(cp, draft, setDraft, t("Ask CodePilot…"));
  const connected = state.connection === "connected";
  const title = state.sessions.find((s) => s.id === state.sessionId)?.title;

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-subtle)] px-2">
        <LogoMark size={18} />
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
          title={t("History")}
        >
          <span className="truncate">{title || (state.sessionId ? t("Sessions") : "CodePilot")}</span>
        </button>
        <div className="ml-auto flex items-center">
          <ConnectionPill state={state} />
          <button type="button" className="cp-icon-btn ml-1" onClick={() => setShowHistory((v) => !v)} title={t("History")}>
            <ChatIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="cp-icon-btn"
            onClick={() => {
              setShowHistory(false);
              void cp.newSession();
            }}
            disabled={!connected}
            title={t("New chat")}
          >
            <PlusIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      {showHistory && (
        <div className="flex max-h-[50%] min-h-32 flex-col border-b border-[var(--color-edge-subtle)] bg-[var(--color-surface)] pt-2">
          <SessionList
            sessions={state.sessions}
            activeId={state.sessionId}
            onResume={(id) => {
              setShowHistory(false);
              void cp.resumeSession(id);
            }}
            emptyText={t("No saved sessions yet.")}
          />
        </div>
      )}

      {state.connection !== "connected" && state.reconnectAttempt === undefined && (
        <div className="m-2 flex items-start gap-2 rounded-lg bg-[var(--color-remove-dim)] px-3 py-2 text-[12px] text-[var(--color-remove)]">
          {state.connection === "connecting" ? <SpinnerIcon className="mt-0.5 h-3.5 w-3.5" /> : <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 flex-1 break-words">
            {state.connection === "connecting" ? t("Waiting for the CodePilot engine…") : state.connectionError ?? t("Engine stopped")}
          </span>
          {state.connection === "disconnected" && bridge && (
            <button
              type="button"
              className="cp-btn-ghost shrink-0 py-0.5"
              onClick={() => {
                bridge.post({ type: "restart" });
                void cp.connectHost(bridge, "", bridge.kind === "idea" ? "codepilot-idea" : "codepilot-vscode");
              }}
            >
              <RefreshIcon className="h-3 w-3" />
              {t("Restart")}
            </button>
          )}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="px-3 py-3">
          {state.rows.length === 0 && !state.permission && !state.question ? (
            <div className="mt-[10vh] flex flex-col items-center px-4 text-center">
              <LogoMark size={36} className="mb-3" />
              <div className="text-[13px] font-medium text-[var(--color-ink)]">CodePilot</div>
              <div className="mt-1 text-[12px] leading-5 text-[var(--color-ink-dim)]">
                {t("Ask anything about your code. Mention files with @path.")}
              </div>
            </div>
          ) : (
            <Transcript
              rows={state.rows}
              subagents={state.subagents}
              status={state.status}
              activity={state.activity}
              permission={state.permission}
              question={state.question}
              density="compact"
              onDecide={(d) => void cp.decidePermission(d)}
              onAnswer={(a) => void cp.answerQuestion(a)}
              onRetry={() => void cp.retryLast()}
            />
          )}
          <EmbeddedFiles cp={cp} onOpenFile={onOpenFile} />
        </div>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <ReconnectBanner cp={cp} />
        <Composer {...composer} />
      </div>
    </div>
  );
}

/** "Changed files" strip under the transcript; click opens in the IDE. */
function EmbeddedFiles({ cp, onOpenFile }: { cp: Codepilot; onOpenFile(path: string): void }): React.ReactElement | null {
  const files = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of cp.state.rows) {
      if (r.kind === "tool" && r.tool.change && r.tool.status === "ok" && !seen.has(r.tool.change.path)) {
        seen.add(r.tool.change.path);
        out.push(r.tool.change.path);
      }
    }
    return out;
  }, [cp.state.rows]);
  if (files.length === 0 || cp.state.status !== "idle") return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <button key={f} type="button" className="cp-chip hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]" onClick={() => onOpenFile(f)} title={f}>
          {f.split("/").pop()}
        </button>
      ))}
    </div>
  );
}

function joinPath(cwd: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}
