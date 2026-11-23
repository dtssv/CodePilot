/**
 * First-class capability surfaces, not Settings tabs:
 * - Skills · Connectors hub (tabbed)
 * - Schedule / Remote standalone dialogs
 * Plugins stay in Settings — not promoted here.
 */
import { useEffect, useState } from "react";

import type { Locale } from "../i18n.js";
import { t } from "../i18n.js";
import type { Codepilot } from "../state/useCodepilot.js";
import type { Layout, ThemeName, ThemePreference } from "../surface.js";
import type { PanelPosition } from "./settings/GeneralSection.js";
import { SettingsExtras } from "./settings/SettingsExtras.js";
import { XIcon } from "./Icons.js";

/** Hub tabs inside「技能 · 连接器」. */
export type HubTab = "skills" | "connectors" | "custom-mcp";

/** First-class feature surfaces (plugins intentionally excluded). */
export type FeatureSection = HubTab | "remote" | "schedule";

export const FEATURE_SECTIONS: readonly FeatureSection[] = [
  "connectors",
  "custom-mcp",
  "skills",
  "remote",
  "schedule",
] as const;

const HUB_TABS: readonly HubTab[] = ["skills", "connectors", "custom-mcp"];

export function isFeatureSection(section: string | undefined): section is FeatureSection {
  return !!section && (FEATURE_SECTIONS as readonly string[]).includes(section);
}

export function isHubTab(section: string | undefined): section is HubTab {
  return !!section && (HUB_TABS as readonly string[]).includes(section);
}

export function openFeature(section: FeatureSection): void {
  window.dispatchEvent(new CustomEvent("codepilot:open-feature", { detail: { section } }));
}

type ShellProps = {
  cp: Codepilot;
  onComposePrompt?: (text: string) => void;
  themePreference: ThemePreference;
  onTheme(theme: ThemePreference): void;
  themeName: ThemeName;
  onThemeName(name: ThemeName): void;
  onLocale(locale: Locale): void;
  panelPosition?: PanelPosition;
  onPanelPosition?(position: PanelPosition): void;
  layout: Layout;
  onLayout(layout: Layout): void;
};

type View =
  | { kind: "hub"; tab: HubTab }
  | { kind: "schedule" }
  | { kind: "remote" };

function viewFromSection(section: FeatureSection): View {
  if (section === "schedule") return { kind: "schedule" };
  if (section === "remote") return { kind: "remote" };
  return { kind: "hub", tab: section };
}

const HUB_TAB_LABEL: Record<HubTab, string> = {
  skills: "Skills",
  connectors: "Connectors",
  "custom-mcp": "Custom connectors",
};

function FeatureShell({
  title,
  fill,
  onClose,
  tabs,
  activeTab,
  onTab,
  children,
}: {
  title: string;
  fill: boolean;
  onClose(): void;
  tabs?: Array<{ id: string; label: string }>;
  activeTab?: string;
  onTab?(id: string): void;
  children: React.ReactNode;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={
        fill
          ? "fixed inset-0 z-[55] flex flex-col bg-[var(--color-bg)]"
          : "fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      }
      onClick={fill ? undefined : onClose}
    >
      <div
        className={
          fill
            ? "flex h-full w-full flex-col overflow-hidden bg-[var(--color-surface)]"
            : "flex h-[min(720px,90vh)] w-full max-w-3xl animate-fade-in flex-col overflow-hidden rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] shadow-2xl"
        }
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3 sm:px-4">
          <div className="min-w-0 flex-1 text-[13.5px] font-semibold text-[var(--color-ink)]">{title}</div>
          <button type="button" className="cp-icon-btn" title={t("Close")} onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        {tabs && onTab && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-edge-subtle)] px-3 py-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`shrink-0 rounded-lg px-2.5 py-1 text-[12px] ${
                  activeTab === tab.id
                    ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
                }`}
                onClick={() => onTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

function FeatureDialogView({
  view,
  onClose,
  onHubTab,
  ...extras
}: ShellProps & {
  view: View;
  onClose(): void;
  onHubTab(tab: HubTab): void;
}): React.ReactElement {
  const fill = extras.layout === "embedded";
  const section =
    view.kind === "hub" ? view.tab : view.kind === "schedule" ? "schedule" : "remote";
  const title =
    view.kind === "hub"
      ? t("Skills · Connectors")
      : view.kind === "schedule"
        ? t("Schedule")
        : t("Remote");

  return (
    <FeatureShell
      title={title}
      fill={fill}
      onClose={onClose}
      tabs={
        view.kind === "hub"
          ? HUB_TABS.map((id) => ({ id, label: t(HUB_TAB_LABEL[id]) }))
          : undefined
      }
      activeTab={view.kind === "hub" ? view.tab : undefined}
      onTab={
        view.kind === "hub"
          ? (id) => {
              if (isHubTab(id)) onHubTab(id);
            }
          : undefined
      }
    >
      <SettingsExtras
        {...extras}
        section={section}
        onComposePrompt={(text) => {
          extras.onComposePrompt?.(text);
          onClose();
        }}
      />
    </FeatureShell>
  );
}

/** Listens for `codepilot:open-feature` and mounts the matching surface. */
export function FeatureDialogHost(props: ShellProps): React.ReactElement | null {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    const open = (ev: Event): void => {
      const next = (ev as CustomEvent<{ section?: string }>).detail?.section;
      if (isFeatureSection(next)) setView(viewFromSection(next));
    };
    window.addEventListener("codepilot:open-feature", open);
    return () => window.removeEventListener("codepilot:open-feature", open);
  }, []);

  if (!view) return null;
  return (
    <FeatureDialogView
      {...props}
      view={view}
      onClose={() => setView(null)}
      onHubTab={(tab) => setView({ kind: "hub", tab })}
    />
  );
}
