import type { Theme } from "../../surface.js";
import { t } from "../../i18n.js";
import { MoonIcon, SunIcon } from "../Icons.js";

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle(): void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${t("Theme")}: ${theme === "dark" ? t("Dark") : t("Light")}`}
      className="cp-icon-btn"
    >
      {theme === "dark" ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
    </button>
  );
}