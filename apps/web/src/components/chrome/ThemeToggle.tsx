import type { Theme, ThemePreference } from "../../surface.js";
import { t } from "../../i18n.js";
import { MoonIcon, SunIcon } from "../Icons.js";

function prefLabel(pref: ThemePreference): string {
  if (pref === "system") return t("System");
  return pref === "dark" ? t("Dark") : t("Light");
}

export function ThemeToggle({
  theme,
  preference = theme,
  onToggle,
}: {
  /** Resolved appearance. */
  theme: Theme;
  preference?: ThemePreference;
  onToggle(): void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${t("Theme")}: ${prefLabel(preference)}`}
      className="cp-icon-btn"
    >
      {theme === "dark" ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
    </button>
  );
}