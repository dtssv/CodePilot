import type { Codepilot } from "../state/useCodepilot.js";
import type { Layout, Theme, ThemeName } from "../surface.js";

export interface LayoutProps {
  cp: Codepilot;
  draft: string;
  setDraft(v: string): void;
  theme: Theme;
  toggleTheme(): void;
  setThemePersist(theme: Theme): void;
  themeName: ThemeName;
  setThemeNamePersist(name: ThemeName): void;
  layout: Layout;
  switchLayout(layout: Layout): void;
}
