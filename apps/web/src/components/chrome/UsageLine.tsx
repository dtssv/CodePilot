import type { AppState } from "../../state/reducer.js";
import { deriveUsageMetrics, formatCacheRatio, formatTokens } from "../../state/selectors.js";
import { t } from "../../i18n.js";

/** Token totals line used under the composer (model shown via ModelPicker). */
export function UsageLine({ state }: { state: AppState }): React.ReactElement | null {
  if (state.usage.input === 0 && state.usage.output === 0) return null;
  const m = deriveUsageMetrics(state.usage);
  return (
    <span className="flex items-center gap-2">
      <span>
        {formatTokens(m.total)} {t("tokens")}
        {` · ${t("in")} ${formatTokens(m.input)}`}
        {` · ${t("out")} ${formatTokens(m.output)}`}
        {m.cache > 0
          ? ` · ${t("cache")} ${formatTokens(m.cache)} (${formatCacheRatio(m.cacheRatio)})`
          : ""}
        {state.usage.costUSD !== undefined ? ` · $${state.usage.costUSD.toFixed(3)}` : ""}
      </span>
    </span>
  );
}