import type { AppState } from "../../state/reducer.js";
import { t } from "../../i18n.js";

export function ConnectionPill({ state }: { state: AppState }): React.ReactElement {
  const reconnecting = state.connection === "connecting" && state.reconnectAttempt !== undefined;
  const tone =
    state.connection === "connected"
      ? "bg-[var(--color-add)]"
      : state.connection === "connecting"
        ? "bg-[var(--color-warn)] animate-breathe"
        : "bg-[var(--color-remove)]";
  const label = reconnecting
    ? `${t("reconnecting")} (${state.reconnectAttempt})`
    : t(state.connection);
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-ink-dim)]" title={state.connectionError}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
      {label}
    </span>
  );
}