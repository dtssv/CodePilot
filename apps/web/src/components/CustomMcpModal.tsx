/**
 * Custom MCP manager — standalone settings section (list + add JSON view + capabilities).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Codepilot } from "../state/useCodepilot.js";
import { describeError } from "../protocol/client.js";
import { t } from "../i18n.js";

type MarketLink = {
  id: string;
  name: string;
  description: string;
  url: string;
};

type InstalledMcp = {
  name: string;
  enabled: boolean;
  summary: string;
  command?: string;
  url?: string;
  type?: string;
};

type Caps = {
  connected: boolean;
  tools: Array<{ name: string; description: string }>;
  resources: Array<{ uri: string; name: string; description?: string }>;
  prompts: Array<{ name: string; description?: string }>;
  error?: string;
  needsAuth?: boolean;
};

const DEFAULT_JSON = `{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "some-server"]
    }
  }
}`;

const CAPS_PREVIEW = 40;

function isRemoteMcp(s: InstalledMcp): boolean {
  return Boolean(s.url?.trim()) || s.type === "http" || s.type === "sse";
}

export function CustomMcpPanel({ cp }: { cp: Codepilot }): React.ReactElement {
  const { client, state } = cp;
  const [servers, setServers] = useState<InstalledMcp[]>([]);
  const [markets, setMarkets] = useState<MarketLink[]>([]);
  const [query, setQuery] = useState("");
  const [capsFilter, setCapsFilter] = useState("");
  const [view, setView] = useState<"list" | "add">("list");
  const [pasteJson, setPasteJson] = useState(DEFAULT_JSON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [capsByName, setCapsByName] = useState<Record<string, Caps | "loading" | "idle">>({});
  const [oauthByName, setOauthByName] = useState<
    Record<string, { state: string; url?: string; error?: string }>
  >({});
  const [showAllTools, setShowAllTools] = useState<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    if (state.connection !== "connected") return;
    try {
      const [s, m] = await Promise.all([client.listInstalledMcp(), client.listMcpMarkets()]);
      setServers(s.servers);
      setMarkets(m.markets);
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
  }, [reload]);

  useEffect(() => {
    const onRequired = (p: { name: string; url: string }): void => {
      setOauthByName((m) => ({
        ...m,
        [p.name]: { state: "pending", url: p.url },
      }));
      setNotice(`${t("Authorize")} ${p.name}: ${t("Open the URL if the browser did not.")}`);
      try {
        window.open(p.url, "_blank", "noopener,noreferrer");
      } catch {
        /* ignore */
      }
    };
    client.setMcpOauthRequiredHandler(onRequired);
    return () => client.setMcpOauthRequiredHandler(null);
  }, [client]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) => s.name.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q),
    );
  }, [servers, query]);

  const enabledCount = servers.filter((s) => s.enabled).length;
  const hub = markets[0];

  const loadCaps = async (name: string): Promise<void> => {
    setCapsByName((m) => ({ ...m, [name]: "loading" }));
    try {
      const r = await client.inspectMcp(name);
      setCapsByName((m) => ({
        ...m,
        [name]: {
          connected: r.connected,
          tools: r.tools,
          resources: r.resources,
          prompts: r.prompts,
          error: r.error,
          needsAuth: r.needsAuth,
        },
      }));
    } catch (err) {
      setCapsByName((m) => ({
        ...m,
        [name]: {
          connected: false,
          tools: [],
          resources: [],
          prompts: [],
          error: describeError(err),
        },
      }));
    }
  };

  const stopOauthPoll = (): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startOauth = async (name: string): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    try {
      const start = await client.startMcpOauth(name);
      setOauthByName((m) => ({
        ...m,
        [name]: { state: start.state, url: start.url, error: start.error },
      }));
      if (start.url) {
        try {
          window.open(start.url, "_blank", "noopener,noreferrer");
        } catch {
          /* ignore */
        }
      }
      stopOauthPoll();
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const st = await client.mcpOauthStatus(name);
            setOauthByName((m) => ({
              ...m,
              [name]: { state: st.state, url: st.url, error: st.error },
            }));
            if (st.state === "authorized") {
              stopOauthPoll();
              setNotice(t("Authorization complete."));
              void loadCaps(name);
            } else if (st.state === "error" || st.state === "idle") {
              stopOauthPoll();
              if (st.error) setError(st.error);
            }
          } catch {
            /* keep polling */
          }
        })();
      }, 1500);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const expand = (name: string): void => {
    const next = expanded === name ? null : name;
    setExpanded(next);
    setCapsFilter("");
    if (next) {
      const cur = capsByName[next];
      if (!cur || cur === "idle") void loadCaps(next);
    }
  };

  const installPaste = async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await client.installMcpJson(pasteJson);
      setNotice(r.message);
      setPasteJson(DEFAULT_JSON);
      setView("list");
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const r = await client.setMcpEnabled(name, enabled);
      setNotice(r.message);
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
          <h3 className="text-[13px] font-semibold text-[var(--color-ink)]">{t("MCP service manager")}</h3>
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
            {t("+ Add MCP")}
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
          <span className="cp-eyebrow">{t("Paste connector JSON")}</span>
          <textarea
            className="cp-input mt-0.5 min-h-48 w-full font-mono text-[11.5px]"
            value={pasteJson}
            onChange={(e) => setPasteJson(e.target.value)}
            spellCheck={false}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {hub && (
              <a
                href={hub.url}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-[var(--color-accent)] underline-offset-2 hover:underline"
                title={hub.description}
              >
                ↗ {hub.name}
              </a>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                className="cp-btn-ghost"
                disabled={busy}
                onClick={() => setView("list")}
              >
                {t("Cancel")}
              </button>
              <button type="button" className="cp-btn" disabled={busy} onClick={() => void installPaste()}>
                {t("Install from JSON")}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              className="cp-input min-w-0 flex-1 text-[12.5px]"
              placeholder={t("Search MCP")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {hub && (
              <a
                href={hub.url}
                target="_blank"
                rel="noreferrer"
                className="cp-btn-ghost shrink-0 whitespace-nowrap px-2.5 py-1.5 text-[12px]"
                title={hub.description}
              >
                ↗ {hub.name}
              </a>
            )}
          </div>

          {markets.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {markets.slice(1).map((m) => (
                <a
                  key={m.id}
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-[var(--color-edge-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                >
                  {m.name} ↗
                </a>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-[var(--color-ink)]">
              {t("My MCPs")}({servers.length})
            </span>
            <span className="text-[var(--color-ink-faint)]">
              {enabledCount} {t("enabled")}
            </span>
          </div>

          <div className="space-y-1.5">
            {filtered.map((s) => {
              const openRow = expanded === s.name;
              const initial = (s.name[0] ?? "M").toUpperCase();
              const caps = capsByName[s.name];
              const oauth = oauthByName[s.name];
              const remote = isRemoteMcp(s);
              const capObj = caps && caps !== "loading" && caps !== "idle" ? caps : null;
              const filterQ = capsFilter.trim().toLowerCase();
              const toolsFiltered =
                capObj?.tools.filter(
                  (tool) =>
                    !filterQ ||
                    tool.name.toLowerCase().includes(filterQ) ||
                    tool.description.toLowerCase().includes(filterQ),
                ) ?? [];
              const showAll = showAllTools[s.name] === true;
              const toolsShown = showAll ? toolsFiltered : toolsFiltered.slice(0, CAPS_PREVIEW);
              return (
                <div
                  key={s.name}
                  className="rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-surface-raised)]"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                    onClick={() => expand(s.name)}
                  >
                    <span className="text-[11px] text-[var(--color-ink-faint)]">{openRow ? "▾" : "▸"}</span>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-[13px] font-semibold text-white">
                      {initial}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            s.enabled ? "bg-[var(--color-add)]" : "bg-[var(--color-ink-faint)]"
                          }`}
                        />
                        <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">{s.name}</span>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--color-ink-faint)]">
                        {s.summary}
                      </span>
                    </span>
                  </button>
                  {openRow && (
                    <div className="space-y-2 border-t border-[var(--color-edge-subtle)] px-3 py-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        {remote && (
                          <button
                            type="button"
                            className="cp-btn py-1 text-[11px]"
                            disabled={busy || oauth?.state === "pending"}
                            onClick={() => void startOauth(s.name)}
                          >
                            {oauth?.state === "pending"
                              ? t("Waiting for authorization…")
                              : t("Authorize")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="cp-btn-ghost py-1 text-[11px]"
                          disabled={busy || caps === "loading"}
                          onClick={() => void loadCaps(s.name)}
                        >
                          {t("Refresh capabilities")}
                        </button>
                        <button
                          type="button"
                          className="cp-btn-ghost py-1 text-[11px]"
                          disabled={busy}
                          onClick={() => void toggle(s.name, !s.enabled)}
                        >
                          {s.enabled ? t("Disable") : t("Enable")}
                        </button>
                      </div>
                      {oauth?.url && oauth.state === "pending" && (
                        <p className="break-all text-[11px] text-[var(--color-ink-dim)]">
                          <a
                            href={oauth.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--color-accent)] underline"
                          >
                            {t("Open authorisation")}
                          </a>
                        </p>
                      )}
                      {oauth?.state === "error" && oauth.error && (
                        <p className="text-[11.5px] text-[var(--color-remove)]">{oauth.error}</p>
                      )}
                      {caps === "loading" && (
                        <p className="text-[11.5px] text-[var(--color-ink-faint)]">{t("Loading capabilities…")}</p>
                      )}
                      {capObj && (
                        <div className="space-y-2 text-[11.5px]">
                          {capObj.error && (
                            <p className="text-[var(--color-remove)]">{capObj.error}</p>
                          )}
                          {capObj.needsAuth && (
                            <p className="text-[var(--color-warn)]">
                              {t("This MCP needs authorization. Click Authorize, then refresh.")}
                            </p>
                          )}
                          {!capObj.error && (
                            <p className="text-[var(--color-ink-faint)]">
                              {capObj.connected
                                ? t("Connected — tools / resources / prompts below.")
                                : t("Not connected.")}
                            </p>
                          )}
                          {(capObj.tools.length > CAPS_PREVIEW || capObj.tools.length > 8) && (
                            <input
                              className="cp-input w-full text-[12px]"
                              placeholder={t("Filter tools…")}
                              value={capsFilter}
                              onChange={(e) => setCapsFilter(e.target.value)}
                            />
                          )}
                          {toolsFiltered.length > 0 && (
                            <div>
                              <div className="mb-1 font-medium text-[var(--color-ink)]">
                                {t("Tools")} ({toolsFiltered.length}
                                {filterQ ? ` / ${capObj.tools.length}` : ""})
                              </div>
                              <ul className="max-h-40 space-y-1 overflow-auto">
                                {toolsShown.map((tool) => (
                                  <li key={tool.name} className="rounded-lg bg-[var(--color-surface)] px-2 py-1.5">
                                    <div className="font-mono text-[12px] text-[var(--color-ink)]">{tool.name}</div>
                                    {tool.description && (
                                      <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--color-ink-faint)]">
                                        {tool.description}
                                      </div>
                                    )}
                                  </li>
                                ))}
                              </ul>
                              {!showAll && toolsFiltered.length > CAPS_PREVIEW && (
                                <button
                                  type="button"
                                  className="mt-1 text-[11px] text-[var(--color-accent)]"
                                  onClick={() =>
                                    setShowAllTools((m) => ({ ...m, [s.name]: true }))
                                  }
                                >
                                  {t("Show all")} ({toolsFiltered.length})
                                </button>
                              )}
                            </div>
                          )}
                          {capObj.resources.length > 0 && (
                            <div>
                              <div className="mb-1 font-medium text-[var(--color-ink)]">
                                {t("Resources")} ({capObj.resources.length})
                              </div>
                              <ul className="max-h-28 space-y-1 overflow-auto font-mono text-[11px] text-[var(--color-ink-dim)]">
                                {capObj.resources.slice(0, CAPS_PREVIEW).map((r) => (
                                  <li key={r.uri}>{r.name || r.uri}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {capObj.prompts.length > 0 && (
                            <div>
                              <div className="mb-1 font-medium text-[var(--color-ink)]">
                                {t("Prompts")} ({capObj.prompts.length})
                              </div>
                              <ul className="max-h-28 space-y-1 overflow-auto font-mono text-[11px] text-[var(--color-ink-dim)]">
                                {capObj.prompts.slice(0, CAPS_PREVIEW).map((p) => (
                                  <li key={p.name}>{p.name}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {!capObj.error &&
                            capObj.tools.length === 0 &&
                            capObj.resources.length === 0 &&
                            capObj.prompts.length === 0 &&
                            capObj.connected && (
                              <p className="text-[var(--color-ink-faint)]">{t("No tools advertised.")}</p>
                            )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="py-6 text-center text-[12px] text-[var(--color-ink-faint)]">
                {servers.length === 0 ? t("No MCP installed yet. Click + Add MCP.") : t("No matching MCP.")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
