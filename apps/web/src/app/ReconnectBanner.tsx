import { SpinnerIcon } from "../components/Icons.js";
import type { Codepilot } from "../state/useCodepilot.js";
import { t } from "../i18n.js";

export function ReconnectBanner({ cp }: { cp: Codepilot }): React.ReactElement | null {
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
