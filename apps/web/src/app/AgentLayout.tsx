import { useEffect, useMemo, useState } from "react";

import type { ImageAttachment, PromptFile } from "@codepilot/core";
import type { Codepilot } from "../state/useCodepilot.js";
import { loadPrefs, sameCwd } from "../prefs.js";
import type { Surface } from "../surface.js";
import { t } from "../i18n.js";
import { Transcript } from "../components/Transcript.js";
import {
  Composer,
  ConnectScreen,
  ThemeToggle,
  WorkspaceSessionNav,
  useStickyScroll,
} from "../components/Chrome.js";
import { AgentHome, FilePreview, TaskPanel } from "../components/AgentView.js";
import { parseReference } from "../state/paths.js";
import type { Row } from "../state/rows.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import {
  CodeIcon,
  LogoMark,
  PlusIcon,
  RocketIcon,
  SidebarIcon,
  WrenchIcon,
  XIcon,
} from "../components/Icons.js";
import type { LayoutProps } from "./layoutTypes.js";
import { needsConnectScreen, openResolvedPath, pickWorkspaceViaSystem, scrollSignature } from "./helpers.js";
import { useComposer } from "./useComposer.js";
import { ReconnectBanner } from "./ReconnectBanner.js";
import { TaskStatusChip } from "./TaskStatusChip.js";

export function AgentLayout({
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
  const [preview, setPreview] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const remote = surface.remote || cp.client.isRemoteControl();
  const canPickWorkspace = !remote && cp.client.canPickWorkspace();
  const [showNav, setShowNav] = useState(() => !remote);
  const { setRef: scrollRef, elRef: scrollElRef } = useStickyScroll(
    scrollSignature(state.rows) + (state.permission ? "p" : "") + (state.question ? "q" : ""),
    { sessionKey: state.sessionId, onNearTop: () => void cp.loadOlderHistory() },
  );
  const connected = state.connection === "connected";
  const inTask = !!state.sessionId;

  // The first-run guide can request the Settings panel via a window event.
  useEffect(() => {
    const open = (): void => setShowSettings(true);
    window.addEventListener("codepilot:open-settings", open);
    return () => window.removeEventListener("codepilot:open-settings", open);
  }, []);

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
    if (!canPickWorkspace) return;
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

  const nav = (
    <>
      <div className={`flex h-14 shrink-0 items-center gap-2.5 px-4 ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
        <LogoMark size={26} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[13.5px] font-semibold tracking-tight text-[var(--color-ink)]">CodePilot</div>
          <div className="text-[10.5px] text-[var(--color-ink-faint)]">
            {remote ? t("Remote control") : t("Agent")}
          </div>
        </div>
        {remote && (
          <button type="button" className="cp-icon-btn shrink-0" title={t("Close")} onClick={() => setShowNav(false)}>
            <XIcon className="h-4 w-4" />
          </button>
        )}
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
        canOpenNewWorkspace={canPickWorkspace}
        onOpenWorkspace={(ws) => void cp.openWorkspace(ws)}
        onCloseWorkspace={(ws) => void cp.closeWorkspace(ws)}
        onOpenNewWorkspace={() => void openNewWorkspace()}
        onNewSession={() => cp.closeSession()}
        onResumeSession={(id, cwd) => void resumeInWorkspace(id, cwd)}
        onPinSession={(id, pinned) => void cp.pinSession(id, pinned)}
        onArchiveSession={(id, archived) => void cp.archiveSession(id, archived)}
        canFork={!!state.sessionId}
        onFork={() => void cp.forkSession()}
        onRefresh={() => void cp.refreshSessions()}
      />
      <div className="flex items-center gap-1 border-t border-[var(--color-edge-subtle)] px-3 py-2">
        {!remote && (
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
        )}
        <div className="ml-auto flex items-center">
          {!remote && (
            <button type="button" className="cp-icon-btn" onClick={onSwitch} title={t("Code view")}>
              <CodeIcon className="h-4 w-4" />
            </button>
          )}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </div>
    </>
  );

  return (
    <div className="relative flex h-full bg-[var(--color-bg)]">
      {!remote && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-edge-subtle)] bg-[var(--color-surface)]">
          {window.codepilotDesktop?.platform === "darwin" && <div className="h-7 shrink-0 [-webkit-app-region:drag]" />}
          {nav}
        </aside>
      )}

      {remote && showNav && (
        <div className="absolute inset-0 z-40 flex">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label={t("Close")}
            onClick={() => setShowNav(false)}
          />
          <aside className="relative z-10 flex h-full w-[min(18rem,88vw)] flex-col bg-[var(--color-surface)] shadow-2xl">
            {nav}
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {window.codepilotDesktop?.platform === "darwin" && !remote && (
          <div className="h-7 shrink-0 [-webkit-app-region:drag]" />
        )}
        {inTask ? (
          <>
            <header
              className={`flex h-14 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3 sm:gap-3 sm:px-5 ${
                surface.desktop ? "[-webkit-app-region:drag]" : ""
              }`}
            >
              {remote && (
                <button
                  type="button"
                  className="cp-icon-btn shrink-0"
                  title={t("Sessions")}
                  onClick={() => setShowNav(true)}
                >
                  <SidebarIcon className="h-4 w-4" />
                </button>
              )}
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--color-ink)]">{taskTitle}</span>
              <TaskStatusChip cp={cp} />
              <div className="ml-auto flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
                <button type="button" className="cp-btn-ghost py-1" onClick={() => cp.closeSession()}>
                  <PlusIcon className="h-3 w-3" />
                  <span className="hidden sm:inline">{t("New task")}</span>
                </button>
              </div>
            </header>
            <div
              key={state.sessionId ?? "none"}
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-auto"
            >
              <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
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
                  planInline={remote}
                  onDecide={(d) => void cp.decidePermission(d)}
                  onAnswer={(a) => void cp.answerQuestion(a)}
                  onRetry={() => void cp.retryLast()}
                  onOpenPath={(p) => setPreview(parseReference(p).path)}
                />
              </div>
            </div>
            <div className="shrink-0 px-3 pb-4 sm:px-6 sm:pb-5">
              <div data-cp-composer className="mx-auto w-full max-w-3xl">
                <ReconnectBanner cp={cp} />
                <Composer {...taskComposer} />
              </div>
            </div>
          </>
        ) : (
          <div className={`relative min-h-0 flex-1 overflow-auto ${surface.desktop ? "[-webkit-app-region:drag]" : ""}`}>
            {remote && (
              <div className="absolute left-2 top-2 z-10 [-webkit-app-region:no-drag]">
                <button
                  type="button"
                  className="cp-icon-btn bg-[var(--color-surface)] shadow"
                  title={t("Sessions")}
                  onClick={() => setShowNav(true)}
                >
                  <SidebarIcon className="h-4 w-4" />
                </button>
              </div>
            )}
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

      {inTask && !remote && (
        <TaskPanel
          state={state}
          onOpenFile={(p) => setPreview(parseReference(p).path)}
          client={cp.client}
          sessionId={state.sessionId}
        />
      )}
      {preview && (
        <FilePreview
          client={cp.client}
          path={preview}
          cwd={state.cwd}
          onClose={() => setPreview(null)}
          onOpenExternally={window.codepilotDesktop ? (p) => void openResolvedPath(cp.client, state.cwd, p) : undefined}
        />
      )}
      {!remote && (
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
      )}
    </div>
  );
}
