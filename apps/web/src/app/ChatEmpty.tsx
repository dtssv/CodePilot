import { FolderIcon, LogoMark } from "../components/Icons.js";
import { t } from "../i18n.js";
import { CHAT_SUGGESTIONS } from "./helpers.js";

export function ChatEmpty({
  hasSession,
  hasWorkspace,
  canOpenWorkspace = true,
  onOpenWorkspace,
  onPick,
}: {
  hasSession: boolean;
  hasWorkspace: boolean;
  canOpenWorkspace?: boolean;
  onOpenWorkspace(): void;
  onPick(p: string): void;
}): React.ReactElement {
  if (!hasWorkspace) {
    return (
      <div className="mt-[12vh] flex flex-col items-center text-center">
        <FolderIcon className="mb-4 h-12 w-12 text-[var(--color-accent)]" />
        <div className="text-[18px] font-semibold tracking-tight text-[var(--color-ink)]">
          {canOpenWorkspace ? t("Open a workspace") : t("Waiting for workspace")}
        </div>
        <div className="mt-1.5 max-w-sm text-[13px] leading-5 text-[var(--color-ink-dim)]">
          {canOpenWorkspace
            ? t("Sessions are tied to a workspace. Open one or more from the sidebar.")
            : t("This remote session uses the host workspace. Ask the host to open a folder first.")}
        </div>
        {canOpenWorkspace && (
          <button type="button" className="cp-btn-primary mt-6" onClick={onOpenWorkspace}>
            <FolderIcon className="h-3.5 w-3.5" />
            {t("Open workspace…")}
          </button>
        )}
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
