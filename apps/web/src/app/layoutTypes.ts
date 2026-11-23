import type { Locale } from "../i18n.js";
import type { PanelPosition } from "../components/settings/GeneralSection.js";
import type { Codepilot } from "../state/useCodepilot.js";
import type { Layout, Theme, ThemeName, ThemePreference } from "../surface.js";

export interface LayoutProps {
  cp: Codepilot;
  draft: string;
  setDraft(v: string): void;
  /** Resolved light/dark currently applied. */
  theme: Theme;
  /** Saved choice including `system`. */
  themePreference: ThemePreference;
  toggleTheme(): void;
  setThemePersist(theme: ThemePreference): void;
  themeName: ThemeName;
  setThemeNamePersist(name: ThemeName): void;
  /** Persist UI language for this client; mirror to sibling IDE webviews. */
  setLocalePersist(locale: Locale): void;
  /** VS Code chat dock (embedded only). */
  panelPosition?: PanelPosition;
  setPanelPosition?(position: PanelPosition): void;
  layout: Layout;
  switchLayout(layout: Layout): void;
}
