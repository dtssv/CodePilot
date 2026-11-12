/**
 * Plugin manager — standalone settings section. Browse the GitHub-hosted
 * marketplace (or install from a git URL / local path), confirm the install
 * source first (trust gate), list/uninstall installed plugins. Installing runs
 * plugin code (hooks / MCP / runtime), so every install shows the source and
 * asks for confirmation.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Codepilot } from "../state/useCodepilot.js";
import { describeError } from "../protocol/client.js";
import type { PluginCapabilityReport } from "@codepilot/core";
import { t } from "../i18n.js";

type MarketPlugin = {
  name: string;
  description: string;
  source: string;
  version?: string;
  author?: string;
  tags?: string[];
};

/** Render a plugin's capability / side-effect report as short consent lines. */
function CapabilityReportView({ report }: { report: PluginCapabilityReport }): React.ReactElement {
  const lines: string[] = [];
  if (report.tools.length > 0) {
    lines.push(
      `${t("Registers tools")}: ${report.tools.join(", ")}${report.toolsPartial ? ` (${t("names may be incomplete")})` : ""}`,
    );
  } else if (report.toolsPartial) {
    lines.push(t("Registers custom tools (names may be incomplete)"));
  }
  if (report.hasRuntime) lines.push(t("Replaces the agent loop (runtime)"));
  if (report.mcpServers.length > 0) {
    lines.push(`${t("Adds MCP servers")}: ${report.mcpServers.join(", ")}`);
  }
  if (report.hooks.length > 0) lines.push(`${t("Hooks")}: ${report.hooks.join(", ")}`);
  const res: string[] = [];
  if (report.resources.skills > 0) res.push(`${report.resources.skills} ${t("skills")}`);
  if (report.resources.agents > 0) res.push(`${report.resources.agents} ${t("agents")}`);
  if (report.resources.commands > 0) res.push(`${report.resources.commands} ${t("commands")}`);
  if (res.length > 0) lines.push(res.join(" · "));
  if (report.sideEffects.length > 0) {
    lines.push(`${t("Side effects")}: ${report.sideEffects.join(" / ")}`);
  }
  return (
    <div className="space-y-1">
      {report.sideEffectFree ? (
        <p className="text-[11px] font-medium text-[var(--color-add)]">
          ✓ {t("No side effects (skills only)")}
        </p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-[var(--color-ink-dim)]">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type InstalledPlugin = {
  name: string;
  description: string;
  version: string;
  source: string;
  enabled: boolean;
};

export function PluginsPanel({ cp }: { cp: Codepilot }): React.ReactElement {
  const { client, state } = cp;
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [market, setMarket] = useState<MarketPlugin[]>([]);
  const [describe, setDescribe] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "add">("list");
  const [sourceInput, setSourceInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  // The entry awaiting a confirm click (keyed by name), so we surface the
  // install source before running any third-party code.
  const [confirming, setConfirming] = useState<string | null>(null);
  // Capability / side-effect report for whatever is being confirmed, fetched
  // by inspecting the source (download → read manifest → discard) before any
  // install. `inspecting` is the source currently being inspected.
  const [report, setReport] = useState<PluginCapabilityReport | null>(null);
  const [reportError, setReportError] = useState<string | undefined>();
  const [inspecting, setInspecting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (state.connection !== "connected") return;
    try {
      const [inst, mkt] = await Promise.all([
        client.listInstalledPlugins(),
        client.listPluginMarket(),
      ]);
      setInstalled(inst.plugins);
      setMarket(mkt.plugins);
      setDescribe(mkt.describe);
      setError(undefined);
    } catch (err) {
      setError(describeError(err));
    }
  }, [client, state.connection]);

  useEffect(() => {
    void reload();
    setView("list");
    setNotice(undefined);
    setError(undefined);
    setConfirming(null);
    setReport(null);
    setReportError(undefined);
  }, [reload]);

  const installedNames = useMemo(
    () => new Set(installed.map((p) => p.name)),
    [installed],
  );

  const filteredMarket = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return market;
    return market.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.tags ?? []).some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [market, query]);

  // Inspect a source before installing: fetches what the plugin WILL do
  // (tools / side effects) so the confirm step shows it. Keyed so the UI can
  // reveal the report under the right entry.
  const doInspect = async (source: string, key: string): Promise<void> => {
    setConfirming(key);
    setReport(null);
    setReportError(undefined);
    setInspecting(source);
    try {
      const r = await client.inspectPlugin(source);
      setReport(r);
    } catch (err) {
      setReportError(describeError(err));
    } finally {
      setInspecting(null);
    }
  };

  const doInstall = async (source: string): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const r = await client.installPlugin(source);
      setNotice(
        `${t("Installed")} ${r.name} — ${t("restart the session to activate it.")}`,
      );
      setConfirming(null);
      setReport(null);
      setReportError(undefined);
      setSourceInput("");
      setView("list");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const doUninstall = async (name: string): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const r = await client.uninstallPlugin(name);
      setNotice(r.removed ? `${t("Uninstalled")} ${name}` : `${name}: ${t("not installed")}`);
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("Plugin manager")}</h3>
          <p className="mt-0.5 text-[11.5px] leading-4 text-[var(--color-ink-faint)]">
            {t("Plugins bundle skills, agents, commands, hooks, and MCP servers. Installing runs the plugin's code in the current session.")}
          </p>
        </div>
        {view === "list" ? (
          <button
            type="button"
            className="cp-btn shrink-0 py-1.5 text-[12px]"
            disabled={busy}
            onClick={() => {
              setView("add");
              setError(undefined);
              setNotice(undefined);
            }}
          >
            {t("+ Install from URL")}
          </button>
        ) : (
          <button
            type="button"
            className="cp-btn-ghost shrink-0 py-1.5 text-[12px]"
            disabled={busy}
            onClick={() => {
              setView("list");
              setError(undefined);
            }}
          >
            {t("Back")}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--color-remove)]/30 bg-[var(--color-remove)]/10 px-3 py-2 text-[12px] text-[var(--color-remove)]">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent-dim)] px-3 py-2 text-[12px] text-[var(--color-ink)]">
          {notice}
        </div>
      )}

      {view === "add" ? (
        <div className="space-y-2 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] p-3">
          <span className="cp-eyebrow">{t("Install from a git URL or local path")}</span>
          <input
            className="cp-input mt-0.5 w-full font-mono text-[12px]"
            placeholder="https://github.com/acme/my-plugin.git"
            value={sourceInput}
            onChange={(e) => {
              setSourceInput(e.target.value);
              // Any edit invalidates a previously-fetched report.
              if (confirming === "__url__") {
                setConfirming(null);
                setReport(null);
                setReportError(undefined);
              }
            }}
            spellCheck={false}
          />
          <p className="text-[11px] leading-4 text-[var(--color-ink-faint)]">
            {t("A git URL is cloned; a local path is copied.")}
          </p>
          {confirming === "__url__" && (
            <div className="space-y-2 rounded-lg border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2">
              {inspecting === sourceInput.trim() ? (
                <p className="text-[11px] text-[var(--color-ink-faint)]">{t("Inspecting")}…</p>
              ) : reportError ? (
                <p className="text-[11px] text-[var(--color-remove)]">{reportError}</p>
              ) : report ? (
                <>
                  <p className="text-[11px] font-medium text-[var(--color-ink)]">
                    {report.displayName ?? report.name} v{report.version}
                  </p>
                  <CapabilityReportView report={report} />
                </>
              ) : null}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="cp-btn-ghost" disabled={busy} onClick={() => setView("list")}>
              {t("Cancel")}
            </button>
            {confirming === "__url__" && report ? (
              <button
                type="button"
                className="cp-btn"
                disabled={busy}
                onClick={() => void doInstall(sourceInput.trim())}
              >
                {busy ? `${t("Installing")}…` : t("Confirm install")}
              </button>
            ) : (
              <button
                type="button"
                className="cp-btn"
                disabled={busy || !sourceInput.trim() || inspecting === sourceInput.trim()}
                onClick={() => void doInspect(sourceInput.trim(), "__url__")}
              >
                {inspecting === sourceInput.trim() ? `${t("Inspecting")}…` : t("Inspect")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <input
            className="cp-input w-full text-[12.5px]"
            placeholder={t("Search plugins…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {installed.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[var(--color-ink)]">
                {t("Installed")} ({installed.length})
              </div>
              {installed.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2.5 rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2.5"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      p.enabled ? "bg-[var(--color-add)]" : "bg-[var(--color-ink-faint)]"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">{p.name}</span>
                      {p.version && (
                        <span className="shrink-0 text-[11px] text-[var(--color-ink-faint)]">v{p.version}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--color-ink-faint)]">
                      {p.description}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="cp-btn-ghost shrink-0 py-1 text-[11px]"
                    disabled={busy}
                    onClick={() => void doUninstall(p.name)}
                  >
                    {t("Uninstall")}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-[var(--color-ink)]">
              {t("Marketplace")} ({filteredMarket.length})
            </div>
            {filteredMarket.map((p) => {
              const already = installedNames.has(p.name);
              const isConfirming = confirming === p.name;
              return (
                <div
                  key={p.name}
                  className="rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)] px-3 py-2.5"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">{p.name}</span>
                        {p.version && (
                          <span className="shrink-0 text-[11px] text-[var(--color-ink-faint)]">v{p.version}</span>
                        )}
                        {p.author && (
                          <span className="shrink-0 text-[11px] text-[var(--color-ink-faint)]">· {p.author}</span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-4 text-[var(--color-ink-dim)]">
                        {p.description}
                      </span>
                      {p.tags && p.tags.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {p.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)]"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    {already ? (
                      <span className="shrink-0 py-1 text-[11px] text-[var(--color-ink-faint)]">{t("Installed")}</span>
                    ) : (
                      <button
                        type="button"
                        className="cp-btn shrink-0 py-1 text-[11px]"
                        disabled={busy}
                        onClick={() =>
                          isConfirming ? setConfirming(null) : void doInspect(p.source, p.name)
                        }
                      >
                        {t("Install")}
                      </button>
                    )}
                  </div>
                  {isConfirming && !already && (
                    <div className="mt-2 space-y-2 rounded-lg border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2">
                      <p className="text-[11px] leading-4 text-[var(--color-ink-dim)]">
                        {describe[p.name] ?? `${t("Installs from")}: ${p.source}`}
                      </p>
                      {inspecting === p.source ? (
                        <p className="text-[11px] text-[var(--color-ink-faint)]">{t("Inspecting")}…</p>
                      ) : reportError ? (
                        <p className="text-[11px] text-[var(--color-remove)]">{reportError}</p>
                      ) : report ? (
                        <CapabilityReportView report={report} />
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="cp-btn-ghost py-1 text-[11px]"
                          disabled={busy}
                          onClick={() => {
                            setConfirming(null);
                            setReport(null);
                            setReportError(undefined);
                          }}
                        >
                          {t("Cancel")}
                        </button>
                        <button
                          type="button"
                          className="cp-btn py-1 text-[11px]"
                          disabled={busy || inspecting === p.source}
                          onClick={() => void doInstall(p.source)}
                        >
                          {busy ? `${t("Installing")}…` : t("Confirm install")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredMarket.length === 0 && (
              <p className="py-6 text-center text-[12px] text-[var(--color-ink-faint)]">
                {market.length === 0
                  ? t("No marketplace entries available.")
                  : t("No matching plugins.")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
