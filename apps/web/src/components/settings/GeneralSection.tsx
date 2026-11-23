import type { AgentMode, PermissionMode } from "@codepilot/core";
import type React from "react";
import type { SearchEngineInfo } from "../../protocol/client.js";
import { getLocale, t, type Locale } from "../../i18n.js";
import { saveDefaultAgentMode, savePermissionMode } from "../../prefs.js";
import {
  THEME_NAMES,
  type Layout,
  type ThemeName,
  type ThemePreference,
} from "../../surface.js";
import type { Codepilot } from "../../state/useCodepilot.js";
import { GeneralRow } from "./GeneralRow.js";
import { listTemplateEnvVars, parseHeaderLines } from "./helpers.js";
import { THEME_NAME_LABELS } from "./types.js";

export type PanelPosition = "left" | "right" | "top" | "bottom";

export type GeneralSectionProps = {
  cp: Codepilot;
  state: Codepilot["state"];
  themePreference: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  themeName: ThemeName;
  onThemeName: (name: ThemeName) => void;
  onLocale: (locale: Locale) => void;
  /** VS Code / Cursor only — chat dock side. */
  panelPosition?: PanelPosition;
  onPanelPosition?: (position: PanelPosition) => void;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  permissionMode: PermissionMode;
  setPermissionModeState: (mode: PermissionMode) => void;
  setNotice: (v: string | undefined) => void;
  lanAccess: boolean | null;
  lanBusy: boolean;
  toggleLanAccess: (next: boolean) => Promise<void>;
  sandboxMode: "off" | "workspace-write" | "read-only" | null;
  sandboxBusy: boolean;
  changeSandboxMode: (next: "off" | "workspace-write" | "read-only") => Promise<void>;
  updateInfo: { current: string; latest: string | null; available: boolean; canAutoApply: boolean } | null;
  updateBusy: boolean;
  applyUpdate: () => Promise<void>;
  checkUpdate: () => Promise<void>;
  imgGen: { baseURL: string; apiKey: string; model: string; enabled: boolean; hasApiKey: boolean };
  setImgGen: React.Dispatch<React.SetStateAction<GeneralSectionProps["imgGen"]>>;
  saveImageGen: () => Promise<void>;
  search: {
    engines: SearchEngineInfo[];
    choice: string;
    apiKey: string;
    hasApiKey: boolean;
    customUrl: string;
    env: Record<string, string>;
    customDraft: {
      method: "GET" | "POST";
      url: string;
      headersText: string;
      body: string;
      resultsPath: string;
      titleField: string;
      urlField: string;
      snippetField: string;
    };
  };
  setSearch: React.Dispatch<React.SetStateAction<GeneralSectionProps["search"]>>;
  selectedEngine: SearchEngineInfo | undefined;
  saveWebSearch: () => Promise<void>;
  busy: boolean;
};

export function GeneralSection({
  cp,
  state,
  themePreference,
  onTheme,
  themeName,
  onThemeName,
  onLocale,
  panelPosition,
  onPanelPosition,
  layout,
  onLayout,
  permissionMode,
  setPermissionModeState,
  setNotice,
  lanAccess,
  lanBusy,
  toggleLanAccess,
  sandboxMode,
  sandboxBusy,
  changeSandboxMode,
  updateInfo,
  updateBusy,
  applyUpdate,
  checkUpdate,
  imgGen,
  setImgGen,
  saveImageGen,
  search,
  setSearch,
  selectedEngine,
  saveWebSearch,
  busy,
}: GeneralSectionProps): React.ReactElement {
  return (
        <div className="space-y-3">
          <div className="divide-y divide-[var(--color-edge-subtle)] overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
            <GeneralRow title={t("Language")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={getLocale()}
                aria-label={t("Language")}
                onChange={(e) => onLocale(e.target.value as Locale)}
              >
                <option value="zh">{t("Chinese")}</option>
                <option value="en">{t("English")}</option>
              </select>
            </GeneralRow>
            <GeneralRow title={t("Theme")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={themePreference}
                aria-label={t("Theme")}
                onChange={(e) => onTheme(e.target.value as ThemePreference)}
              >
                <option value="system">{t("System")}</option>
                <option value="light">{t("Light")}</option>
                <option value="dark">{t("Dark")}</option>
              </select>
            </GeneralRow>
            {layout === "embedded" && onPanelPosition && (
              <GeneralRow title={t("Panel position")}>
                <select
                  className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                  value={panelPosition ?? "left"}
                  aria-label={t("Panel position")}
                  onChange={(e) => onPanelPosition(e.target.value as PanelPosition)}
                >
                  <option value="left">{t("Left")}</option>
                  <option value="right">{t("Right")}</option>
                  <option value="top">{t("Top")}</option>
                  <option value="bottom">{t("Bottom")}</option>
                </select>
              </GeneralRow>
            )}
            <GeneralRow title={t("Palette")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={themeName}
                aria-label={t("Palette")}
                onChange={(e) => onThemeName(e.target.value as ThemeName)}
              >
                {THEME_NAMES.map((name) => (
                  <option key={name} value={name}>
                    {t(THEME_NAME_LABELS[name])}
                  </option>
                ))}
              </select>
            </GeneralRow>
            {layout !== "embedded" && (
              <GeneralRow title={t("Layout")}>
                <select
                  className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                  value={layout}
                  aria-label={t("Layout")}
                  onChange={(e) => onLayout(e.target.value as Layout)}
                >
                  <option value="web">{t("Code view")}</option>
                  <option value="agent">{t("Agent view")}</option>
                </select>
              </GeneralRow>
            )}
            <GeneralRow title={t("Permission mode")}>
              <select
                className="cp-input w-auto min-w-[9.5rem] shrink-0 py-1.5 text-[12.5px]"
                value={permissionMode}
                aria-label={t("Permission mode")}
                onChange={(e) => {
                  const next = e.target.value as PermissionMode;
                  setPermissionModeState(next);
                  savePermissionMode(next);
                  setNotice(t("Permission mode saved — applies on next connect."));
                }}
              >
                <option value="ask">{t("Ask every time")}</option>
                <option value="auto-edit">{t("Auto-edit")}</option>
                <option value="auto">{t("Auto (classifier)")}</option>
                <option value="dont-ask">{t("Don't ask (deny unprompted)")}</option>
                <option value="yolo">{t("Full access (YOLO)")}</option>
              </select>
            </GeneralRow>
            <GeneralRow title={t("Default mode")}>
              <select
                className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                value={state.agentMode}
                aria-label={t("Default mode")}
                onChange={(e) => {
                  const next = e.target.value as AgentMode;
                  saveDefaultAgentMode(next);
                  void cp.setMode(next);
                }}
              >
                <option value="chat">{t("Ask")}</option>
                <option value="plan">{t("Plan")}</option>
                <option value="agent">{t("Agent")}</option>
              </select>
            </GeneralRow>
            {lanAccess !== null && (
              <GeneralRow title={t("Allow phone access (same Wi‑Fi)")}>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--color-ink-dim)]">
                  <input
                    type="checkbox"
                    checked={lanAccess}
                    disabled={lanBusy}
                    onChange={(e) => void toggleLanAccess(e.target.checked)}
                  />
                  {lanBusy ? `${t("Applying")}…` : lanAccess ? t("On") : t("Off")}
                </label>
              </GeneralRow>
            )}
            {sandboxMode !== null && (
              <GeneralRow title={t("Tool sandbox")}>
                <select
                  className="cp-input w-auto min-w-[8rem] shrink-0 py-1.5 text-[12.5px]"
                  value={sandboxMode}
                  aria-label={t("Tool sandbox")}
                  disabled={sandboxBusy}
                  onChange={(e) =>
                    void changeSandboxMode(
                      e.target.value as "off" | "workspace-write" | "read-only",
                    )
                  }
                >
                  <option value="workspace-write">{t("Workspace write")}</option>
                  <option value="read-only">{t("Read-only")}</option>
                  <option value="off">{t("Off (no sandbox)")}</option>
                </select>
              </GeneralRow>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]">
            <GeneralRow title={t("Engine updates")} hint={updateInfo ? `${t("Current")}: ${updateInfo.current}${updateInfo.available ? ` → ${updateInfo.latest ?? ""}` : ` · ${t("up to date")}`}` : t("Check for a newer engine")}>
              <div className="flex shrink-0 items-center gap-2">
                {updateInfo?.available && updateInfo.canAutoApply && (
                  <button type="button" className="cp-btn py-1.5 text-[12px]" disabled={updateBusy} onClick={() => void applyUpdate()}>
                    {t("Install update")}
                  </button>
                )}
                <button type="button" className="cp-btn-ghost py-1.5 text-[12px]" disabled={updateBusy || state.connection !== "connected"} onClick={() => void checkUpdate()}>
                  {updateBusy ? `${t("Checking")}…` : t("Check for updates")}
                </button>
              </div>
            </GeneralRow>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-medium text-[var(--color-ink)]">{t("Image generation")}</div>
              <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--color-ink-dim)]">
                <input
                  type="checkbox"
                  checked={imgGen.enabled}
                  onChange={(e) => setImgGen((p) => ({ ...p, enabled: e.target.checked }))}
                />
                {t("Enabled")}
              </label>
            </div>
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="cp-eyebrow">{t("Base URL")}</span>
                <input
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  placeholder="https://api.openai.com/v1"
                  value={imgGen.baseURL}
                  onChange={(e) => setImgGen((p) => ({ ...p, baseURL: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="cp-eyebrow">{t("API key")}</span>
                <input
                  type="password"
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  placeholder={imgGen.hasApiKey ? "••••••• (" + t("saved") + ")" : ""}
                  value={imgGen.apiKey}
                  onChange={(e) => setImgGen((p) => ({ ...p, apiKey: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="cp-eyebrow">{t("Model")}</span>
                <input
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  placeholder="gpt-image-1"
                  value={imgGen.model}
                  onChange={(e) => setImgGen((p) => ({ ...p, model: e.target.value }))}
                />
              </label>
              <button
                type="button"
                className="cp-btn py-1.5 text-[12px]"
                disabled={busy || state.connection !== "connected"}
                onClick={() => void saveImageGen()}
              >
                {t("Save changes")}
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div className="text-[13px] font-medium text-[var(--color-ink)]">{t("Web search")}</div>
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="cp-eyebrow">{t("Search engine")}</span>
                <select
                  className="cp-input mt-0.5 w-full text-[12.5px]"
                  value={search.choice}
                  aria-label={t("Search engine")}
                  onChange={(e) => {
                    const choice = e.target.value;
                    const eng = search.engines.find((x) => x.id === choice);
                    setSearch((p) => ({
                      ...p,
                      choice,
                      apiKey: "",
                      // Seed env keys for non-key placeholders (e.g. SEARXNG_URL).
                      env: eng
                        ? Object.fromEntries(
                            listTemplateEnvVars(eng.template)
                              .filter((v) => v !== eng.keyEnvVar)
                              .map((v) => [v, p.env[v] ?? ""]),
                          )
                        : p.env,
                      customDraft:
                        choice === "__custom__" && eng == null && !p.customDraft.url
                          ? {
                              ...p.customDraft,
                              url: "https://api.example.com/search?q={query}&n={max}",
                            }
                          : p.customDraft,
                    }));
                  }}
                >
                  <option value="duckduckgo">{t("DuckDuckGo (default, keyless)")}</option>
                  {search.engines.map((eng) => (
                    <option key={eng.id} value={eng.id}>
                      {eng.displayName}
                      {eng.description ? ` — ${eng.description}` : ""}
                    </option>
                  ))}
                  <option value="__custom__">{t("Custom JSON API…")}</option>
                </select>
              </label>
              {selectedEngine?.needsKey && (
                <label className="block">
                  <span className="cp-eyebrow">{t("API key")}</span>
                  <input
                    type="password"
                    className="cp-input mt-0.5 w-full text-[12.5px]"
                    placeholder={search.hasApiKey ? "••••••• (" + t("saved") + ")" : selectedEngine.keyEnvVar ?? ""}
                    value={search.apiKey}
                    onChange={(e) => setSearch((p) => ({ ...p, apiKey: e.target.value }))}
                  />
                  {selectedEngine.signupUrl && (
                    <span className="mt-0.5 block text-[11px] text-[var(--color-ink-faint)]">
                      {t("Get a key")}: {selectedEngine.signupUrl}
                    </span>
                  )}
                </label>
              )}
              {selectedEngine &&
                listTemplateEnvVars(selectedEngine.template)
                  .filter((v) => v !== selectedEngine.keyEnvVar)
                  .map((varName) => (
                    <label key={varName} className="block">
                      <span className="cp-eyebrow">{varName}</span>
                      <input
                        className="cp-input mt-0.5 w-full text-[12.5px]"
                        placeholder={`\${${varName}}`}
                        value={search.env[varName] ?? ""}
                        onChange={(e) =>
                          setSearch((p) => ({
                            ...p,
                            env: { ...p.env, [varName]: e.target.value },
                          }))
                        }
                      />
                    </label>
                  ))}
              {selectedEngine && (
                <div className="text-[11px] leading-4 text-[var(--color-ink-faint)]">
                  {t("Endpoint")}: {selectedEngine.template.url}
                </div>
              )}
              {search.choice === "__custom__" && (
                <div className="space-y-2 rounded-lg border border-[var(--color-edge-subtle)] p-2">
                  <label className="block">
                    <span className="cp-eyebrow">{t("URL template")}</span>
                    <input
                      className="cp-input mt-0.5 w-full font-mono text-[12px]"
                      placeholder="https://…?q={query}&n={max}"
                      value={search.customDraft.url}
                      onChange={(e) =>
                        setSearch((p) => ({
                          ...p,
                          customDraft: { ...p.customDraft, url: e.target.value },
                        }))
                      }
                    />
                    <span className="mt-0.5 block text-[11px] text-[var(--color-ink-faint)]">
                      {t("Placeholders")}: {"{query} {max} {language} {region}"} · {"${ENV}"}
                    </span>
                  </label>
                  <label className="block">
                    <span className="cp-eyebrow">{t("Method")}</span>
                    <select
                      className="cp-input mt-0.5 w-auto min-w-[6rem] text-[12.5px]"
                      value={search.customDraft.method}
                      onChange={(e) =>
                        setSearch((p) => ({
                          ...p,
                          customDraft: {
                            ...p.customDraft,
                            method: e.target.value === "POST" ? "POST" : "GET",
                          },
                        }))
                      }
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="cp-eyebrow">{t("Headers (Name: value, one per line)")}</span>
                    <textarea
                      className="cp-input mt-0.5 w-full font-mono text-[12px]"
                      rows={2}
                      placeholder={"Authorization: Bearer ${MY_KEY}"}
                      value={search.customDraft.headersText}
                      onChange={(e) =>
                        setSearch((p) => ({
                          ...p,
                          customDraft: { ...p.customDraft, headersText: e.target.value },
                        }))
                      }
                    />
                  </label>
                  {search.customDraft.method === "POST" && (
                    <label className="block">
                      <span className="cp-eyebrow">{t("Body (JSON template)")}</span>
                      <textarea
                        className="cp-input mt-0.5 w-full font-mono text-[12px]"
                        rows={2}
                        placeholder={'{"q":"{query}","n":{max}}'}
                        value={search.customDraft.body}
                        onChange={(e) =>
                          setSearch((p) => ({
                            ...p,
                            customDraft: { ...p.customDraft, body: e.target.value },
                          }))
                        }
                      />
                    </label>
                  )}
                  <label className="block">
                    <span className="cp-eyebrow">{t("Results path")}</span>
                    <input
                      className="cp-input mt-0.5 w-full font-mono text-[12px]"
                      placeholder="data.items (empty = response root array)"
                      value={search.customDraft.resultsPath}
                      onChange={(e) =>
                        setSearch((p) => ({
                          ...p,
                          customDraft: { ...p.customDraft, resultsPath: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ["titleField", t("Title field")],
                        ["urlField", t("URL field")],
                        ["snippetField", t("Snippet field")],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="block">
                        <span className="cp-eyebrow">{label}</span>
                        <input
                          className="cp-input mt-0.5 w-full font-mono text-[12px]"
                          value={search.customDraft[key]}
                          onChange={(e) =>
                            setSearch((p) => ({
                              ...p,
                              customDraft: { ...p.customDraft, [key]: e.target.value },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label className="block">
                    <span className="cp-eyebrow">{t("API key (fills ${ENV} when unset)")}</span>
                    <input
                      type="password"
                      className="cp-input mt-0.5 w-full text-[12.5px]"
                      placeholder={search.hasApiKey ? "••••••• (" + t("saved") + ")" : ""}
                      value={search.apiKey}
                      onChange={(e) => setSearch((p) => ({ ...p, apiKey: e.target.value }))}
                    />
                  </label>
                  {listTemplateEnvVars({
                    url: search.customDraft.url,
                    body: search.customDraft.body,
                    headers: parseHeaderLines(search.customDraft.headersText),
                  }).map((varName) => (
                    <label key={varName} className="block">
                      <span className="cp-eyebrow">{varName}</span>
                      <input
                        className="cp-input mt-0.5 w-full text-[12.5px]"
                        placeholder={`\${${varName}}`}
                        value={search.env[varName] ?? ""}
                        onChange={(e) =>
                          setSearch((p) => ({
                            ...p,
                            env: { ...p.env, [varName]: e.target.value },
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="cp-btn py-1.5 text-[12px]"
                disabled={busy || state.connection !== "connected"}
                onClick={() => void saveWebSearch()}
              >
                {t("Save changes")}
              </button>
            </div>
          </div>
        </div>
  );
}
