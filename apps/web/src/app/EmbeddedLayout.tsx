import { useCallback, useEffect, useMemo, useState } from "react";

import { HostBridge } from "../protocol/bridge.js";
import type { Codepilot } from "../state/useCodepilot.js";
import { sameCwd } from "../prefs.js";
import { t } from "../i18n.js";
import { Transcript } from "../components/Transcript.js";
import {
  Composer,
  SessionList,
  useStickyScroll,
} from "../components/Chrome.js";
import { FeatureDialogHost, isFeatureSection } from "../components/FeatureDialog.js";
import { FeatureOverflowMenu } from "../components/FeatureMenu.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import {
  AlertIcon,
  ChatIcon,
  FolderIcon,
  LogoMark,
  PlusIcon,
  RefreshIcon,
  SpinnerIcon,
  WrenchIcon,
} from "../components/Icons.js";
import type { LayoutProps } from "./layoutTypes.js";
import { scrollSignature, shortCwd } from "./helpers.js";
import { useComposer } from "./useComposer.js";
import { ReconnectBanner } from "./ReconnectBanner.js";
import { EmbeddedFiles } from "./EmbeddedFiles.js";

export function EmbeddedLayout({
  cp,
  draft,
  setDraft,
  theme,
  themePreference,
  setThemePersist,
  setLocalePersist,
  panelPosition,
  setPanelPosition,
  themeName,
  setThemeNamePersist,
  layout,
  switchLayout,
  bridge,
  onOpenFile,
  onInsertCode,
}: LayoutProps & {
  bridge: HostBridge | null;
  onOpenFile(path: string, line?: number): void;
  /** Insert a code block into the IDE editor; returns false when unavailable. */
  onInsertCode(text: string): boolean;
}): React.ReactElement {
  const { state } = cp;
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { setRef: scrollRef, elRef: scrollElRef } = useStickyScroll(
    scrollSignature(state.rows) + (state.permission ? "p" : "") + (state.question ? "q" : ""),
    { sessionKey: state.sessionId, onNearTop: () => void cp.loadOlderHistory() },
  );
  const composer = useComposer(cp, draft, setDraft, t("Ask CodePilot…"));
  const connected = state.connection === "connected";
  const title = state.sessions.find((s) => s.id === state.sessionId)?.title;
  const cwdHint = state.cwd ? shortCwd(state.cwd) : "";
  const multiRoot = cp.workspaces.length > 1;

  const switchWorkspace = async (next: string): Promise<void> => {
    if (!next || sameCwd(next, state.cwd)) return;
    await cp.openWorkspace(next);
    bridge?.post({ type: "setCwd", cwd: next });
  };

  const hostView =
    typeof window !== "undefined" ? window.__codepilotHost?.view : undefined;

  const openSettings = useCallback(
    (section?: string): void => {
      // Skills · Connectors / Schedule / Remote open in-webview — not host Settings.
      if (isFeatureSection(section)) {
        window.dispatchEvent(
          new CustomEvent("codepilot:open-feature", { detail: { section } }),
        );
        return;
      }
      // VS Code/Cursor and IDEA both give Settings its own editor surface, which
      // a narrow chat sidebar cannot do. Hand off to the host and stop — the
      // in-panel sheet stays for the standalone web/desktop surface only.
      if (hostView !== "settings") {
        if (bridge && bridge.kind === "vscode") {
          bridge.post({ type: "openSettings", section });
          return;
        }
        if (bridge && bridge.kind === "idea") {
          bridge.post({ type: "openSettings", section });
          return;
        }
      }
      setShowSettings(true);
      if (section) {
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent("codepilot:settings-nav", { detail: { section } })),
        );
      }
    },
    [bridge, hostView],
  );

  useEffect(() => {
    const open = (ev: Event): void => {
      const section = (ev as CustomEvent<{ section?: string }>).detail?.section;
      openSettings(section);
    };
    const showSheet = (): void => setShowSettings(true);
    const openHistory = (): void => setShowHistory(true);
    window.addEventListener("codepilot:open-settings", open);
    window.addEventListener("codepilot:show-settings-sheet", showSheet);
    window.addEventListener("codepilot:open-history", openHistory);
    return () => {
      window.removeEventListener("codepilot:open-settings", open);
      window.removeEventListener("codepilot:show-settings-sheet", showSheet);
      window.removeEventListener("codepilot:open-history", openHistory);
    };
  }, [openSettings]);

  useEffect(() => {
    if (hostView === "settings") setShowSettings(true);
  }, [hostView]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg)]">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-edge-subtle)] px-2">
        <LogoMark size={18} />
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
          title={state.cwd || t("History")}
        >
          <span className="truncate">{title || (state.sessionId ? t("Sessions") : "CodePilot")}</span>
          {cwdHint && !title && !multiRoot && (
            <span className="truncate font-normal text-[11px] text-[var(--color-ink-faint)]">{cwdHint}</span>
          )}
        </button>
        {multiRoot && (
          <label className="flex min-w-0 max-w-[42%] items-center" title={state.cwd || t("Switch workspace folder")}>
            <span className="sr-only">{t("Switch workspace folder")}</span>
            <select
              className="max-w-full truncate rounded-md border border-[var(--color-edge-subtle)] bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink-dim)]"
              value={state.cwd}
              disabled={!connected}
              onChange={(e) => void switchWorkspace(e.target.value)}
            >
              {cp.workspaces.map((ws) => (
                <option key={ws} value={ws}>
                  {shortCwd(ws)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center">
          <FeatureOverflowMenu disabled={!connected} />
          <button
            type="button"
            className="cp-icon-btn"
            onClick={() => openSettings()}
            disabled={!connected}
            title={t("Settings")}
          >
            <WrenchIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="cp-icon-btn" onClick={() => setShowHistory((v) => !v)} title={t("History")}>
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
          {multiRoot && (
            <div className="mb-1 space-y-0.5 px-2">
              <div className="px-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--color-ink-faint)]">
                {t("Workspace folders")}
              </div>
              {cp.workspaces.map((ws) => (
                <button
                  key={ws}
                  type="button"
                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] ${
                    sameCwd(ws, state.cwd)
                      ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
                      : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
                  }`}
                  title={ws}
                  onClick={() => void switchWorkspace(ws)}
                >
                  <FolderIcon className="h-3 w-3 shrink-0" />
                  <span className="truncate">{shortCwd(ws)}</span>
                </button>
              ))}
            </div>
          )}
          <SessionList
            sessions={
              state.cwd
                ? state.sessions.filter((s) => sameCwd(s.cwd, state.cwd))
                : []
            }
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
                void cp.connectHost(
                  bridge,
                  state.cwd || "",
                  bridge.kind === "idea" ? "codepilot-idea" : "codepilot-vscode",
                );
              }}
            >
              <RefreshIcon className="h-3 w-3" />
              {t("Restart")}
            </button>
          )}
        </div>
      )}

      <div
        key={state.sessionId ?? "none"}
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
      >
        <div className="px-3 py-3">
          {state.rows.length === 0 && !state.permission && !state.question ? (
            <div className="mt-[10vh] flex flex-col items-center px-4 text-center">
              <LogoMark size={36} className="mb-3" />
              <div className="text-[13px] font-medium text-[var(--color-ink)]">CodePilot</div>
              <div className="mt-1 text-[12px] leading-5 text-[var(--color-ink-dim)]">
                {t("Ask anything about your code. Mention files with @path.")}
              </div>
              {state.cwd && (
                <div className="mt-2 max-w-full truncate font-mono text-[11px] text-[var(--color-ink-faint)]" title={state.cwd}>
                  {state.cwd}
                </div>
              )}
            </div>
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
              density="compact"
              onDecide={(d) => void cp.decidePermission(d)}
              onAnswer={(a) => void cp.answerQuestion(a)}
              onRetry={() => void cp.retryLast()}
              onOpenPath={onOpenFile}
              onInsertCode={onInsertCode}
              onAddToChat={(text) => {
                const quote = text
                  .split("\n")
                  .map((l) => `> ${l}`)
                  .join("\n");
                setDraft(draft.trim() ? `${draft.trim()}\n\n${quote}` : quote);
              }}
            />
          )}
          <EmbeddedFiles cp={cp} onOpenFile={onOpenFile} />
        </div>
      </div>

      <div data-cp-composer className="shrink-0 px-2 pb-2">
        <ReconnectBanner cp={cp} />
        <Composer {...composer} compact />
      </div>

      <SettingsPanel
        cp={cp}
        open={showSettings}
        onClose={() => {
          setShowSettings(false);
          bridge?.post({ type: "closeSettings" });
        }}
        themePreference={themePreference}
        onTheme={setThemePersist}
        themeName={themeName}
        onThemeName={setThemeNamePersist}
        onLocale={setLocalePersist}
        panelPosition={panelPosition}
        onPanelPosition={setPanelPosition}
        layout={layout}
        onLayout={switchLayout}
        onComposePrompt={(text) => {
          setDraft(text);
          setShowSettings(false);
          bridge?.post({ type: "closeSettings" });
        }}
      />
      <FeatureDialogHost
        cp={cp}
        themePreference={themePreference}
        onTheme={setThemePersist}
        themeName={themeName}
        onThemeName={setThemeNamePersist}
        onLocale={setLocalePersist}
        panelPosition={panelPosition}
        onPanelPosition={setPanelPosition}
        layout={layout}
        onLayout={switchLayout}
        onComposePrompt={(text) => setDraft(text)}
      />
    </div>
  );
}
