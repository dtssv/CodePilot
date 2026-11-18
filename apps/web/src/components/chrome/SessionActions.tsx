import { t } from "../../i18n.js";
import { ForkIcon, RefreshIcon } from "../Icons.js";

export function SessionActions({
  canFork,
  canRefresh,
  onFork,
  onRefresh,
}: {
  canFork: boolean;
  canRefresh: boolean;
  onFork(): void;
  onRefresh(): void;
}): React.ReactElement {
  return (
    <>
      <button type="button" className="cp-icon-btn" onClick={onFork} disabled={!canFork} title={t("Fork from here")}>
        <ForkIcon />
      </button>
      <button type="button" className="cp-icon-btn" onClick={onRefresh} disabled={!canRefresh} title={t("Refresh")}>
        <RefreshIcon />
      </button>
    </>
  );
}