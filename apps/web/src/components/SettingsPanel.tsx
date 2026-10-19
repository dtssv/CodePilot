import { useCallback, useEffect, useMemo, useState } from "react";

import type { Codepilot } from "../state/useCodepilot.js";
import type {
  ConfigProviderPreset,
  ConfigProviderRedacted,
  ConfigSnapshot,
  ProviderTemplateInfo,
} from "../protocol/client.js";
import { describeError } from "../protocol/client.js";
import { t } from "../i18n.js";
import { PlusIcon, RefreshIcon, XIcon } from "./Icons.js";

type ProviderKind = "anthropic" | "openai" | "copilot";

/** A saved endpoint row (one providers-map entry — not bound 1:1 to a vendor). */
type EndpointRow = {
  id: string;
  displayName: string;
  provider: ProviderKind;
  baseURL?: string;
  saved: ConfigProviderRedacted;
 /** Template id this was spawned from, if any (for UI hints only). */
  fromTemplate?: string;
};

function nextEndpointId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const root = (base.trim() || "endpoint").replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i++;
  return `${root}-${i}`;
}

function buildEndpointRows(snap: ConfigSnapshot | null): EndpointRow[] {
  if (!snap) return [];
  return Object.entries(snap.providers).map(([id, p]) => ({
    id,
    displayName: p.displayName ?? id,
    provider: p.provider,
    baseURL: p.baseURL,
    saved: p,
    fromTemplate: snap.templates.some((tmpl) => tmpl.id === id) ? id : undefined,
  }));
}

function isLocalBaseURL(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

/** Match a saved endpoint back to a vendor template (exact id, `id-N` clone, or baseURL). */
function templateForEndpoint(
  snap: ConfigSnapshot,
  id: string,
  saved: ConfigProviderRedacted,
): ProviderTemplateInfo | undefined {
  const exact = snap.templates.find((tmpl) => tmpl.id === id);
  if (exact) return exact;
 // Longest id first so `openai-2` does not match a shorter prefix.
  const clone = [...snap.templates]
    .filter((tmpl) => !tmpl.requiresBaseURL)
    .sort((a, b) => b.id.length - a.id.length)
    .find((tmpl) => id === tmpl.id || id.startsWith(`${tmpl.id}-`));
  if (clone) return clone;
  if (saved.baseURL) {
    const norm = saved.baseURL.replace(/\/+$/, "");
    return snap.templates.find(
      (tmpl) =>
        !!tmpl.baseURL &&
        !tmpl.requiresBaseURL &&
        tmpl.baseURL.replace(/\/+$/, "") === norm,
    );
  }
  return undefined;
}

type DraftMode =
  | { kind: "edit"; id: string }
  | {
      kind: "add";
 /** Suggested providers-map id (editable). */
      id: string;
      provider: ProviderKind;
      displayName: string;
      baseURL: string;
 /** Built-in vendors hide baseURL; custom / ollama show it. */
      showBaseURL: boolean;
      fromTemplate?: string;
    };

/** Provider + model settings drawer — endpoints are independent of vendor templates. */
export function SettingsPanel({
  cp,
  open,
  onClose,
}: {
  cp: Codepilot;
  open: boolean;
  onClose(): void;
}): React.ReactElement | null {
  const { state, client } = cp;
  const [snap, setSnap] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftMode | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);

  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [protocol, setProtocol] = useState<ProviderKind>("openai");
  const [showBaseURL, setShowBaseURL] = useState(true);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [remote, setRemote] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);

  const rows = useMemo(() => buildEndpointRows(snap), [snap]);
  const editing = draft?.kind === "edit" ? rows.find((r) => r.id === draft.id) : null;

  const reload = useCallback(async () => {
    if (state.connection !== "connected") return;
    try {
      const next = await client.getConfig(state.cwd || undefined);
      setSnap(next);
      setError(undefined);
      return next;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, [client, state.connection, state.cwd]);

  useEffect(() => {
    if (!open) return;
    void reload().then((next) => {
      if (!next) return;
      const ids = Object.keys(next.providers);
      const active = next.active.providerId;
      if (active && next.providers[active]) {
        setDraft({ kind: "edit", id: active });
      } else if (ids[0]) {
        setDraft({ kind: "edit", id: ids[0] });
      } else {
        setDraft(null);
        setChooserOpen(true);
      }
    });
  }, [open, reload]);

 // Load editor fields when the draft target changes.
  useEffect(() => {
    if (!draft) return;
    setRemote(null);
    setApiKey("");
    setChooserOpen(false);
    if (draft.kind === "add") {
      setEndpointId(draft.id);
      setProtocol(draft.provider);
      setDisplayName(draft.displayName);
      setBaseURL(draft.baseURL);
      setShowBaseURL(draft.showBaseURL);
      setEnabled([]);
      setDefaultModel("");
      setSmallModel("");
      return;
    }
    if (!snap) return;
    const saved = snap.providers[draft.id];
    if (!saved) return;
    const tmpl = templateForEndpoint(snap, draft.id, saved);
    setEndpointId(draft.id);
    setProtocol(saved.provider);
    setDisplayName(saved.displayName ?? tmpl?.displayName ?? draft.id);
    const needsBase = !tmpl || !!tmpl.requiresBaseURL;
    setShowBaseURL(needsBase);
    setBaseURL(saved.baseURL ?? tmpl?.baseURL ?? "");
    setEnabled(saved.models?.length ? [...saved.models] : []);
    setDefaultModel(saved.model ?? "");
    setSmallModel(saved.smallModel ?? "");
  }, [draft, snap]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const beginFromTemplate = (tmpl: ProviderTemplateInfo): void => {
    const existing = snap ? Object.keys(snap.providers) : [];
    const id = nextEndpointId(tmpl.id, existing);
    const needsBase = !!tmpl.requiresBaseURL;
    setDraft({
      kind: "add",
      id,
      provider: tmpl.provider,
      displayName:
        existing.includes(tmpl.id) || existing.some((x) => x.startsWith(`${tmpl.id}-`))
          ? `${tmpl.displayName} (${id})`
          : tmpl.displayName,
      baseURL: tmpl.baseURL ?? "",
      showBaseURL: needsBase,
      fromTemplate: tmpl.id,
    });
  };

  const beginCustom = (kind: "openai" | "anthropic"): void => {
    const existing = snap ? Object.keys(snap.providers) : [];
    const base = kind === "openai" ? "custom-openai" : "custom-anthropic";
    const id = nextEndpointId(base, existing);
    setDraft({
      kind: "add",
      id,
      provider: kind,
      displayName:
        kind === "openai" ? t("Custom (OpenAI protocol)") : t("Custom (Claude protocol)"),
      baseURL: "",
      showBaseURL: true,
    });
  };

  const effectiveBaseURL = (): string => {
    if (showBaseURL) return baseURL.trim();
    if (draft?.kind === "add" && draft.baseURL) return draft.baseURL;
    if (editing?.baseURL) return editing.baseURL;
    if (draft?.kind === "add" && draft.fromTemplate) {
      return snap?.templates.find((t) => t.id === draft.fromTemplate)?.baseURL ?? "";
    }
    if (editing && snap) {
      return templateForEndpoint(snap, editing.id, editing.saved)?.baseURL ?? "";
    }
    return "";
  };

  const fetchModels = async (): Promise<void> => {
    const key = apiKey.trim();
    const hasSavedKey = !!editing?.saved.hasApiKey;
    const base = effectiveBaseURL();
    const local = isLocalBaseURL(base);
    if (!key && !hasSavedKey && !local && protocol !== "copilot") {
      setError(t("Enter an API key before fetching models"));
      return;
    }
    if (showBaseURL && !base) {
      setError(t("baseURL is required for custom providers"));
      return;
    }
    setFetching(true);
    setError(undefined);
    try {
      const models = await client.listRemoteModels({
        providerId: draft?.kind === "edit" ? draft.id : undefined,
        provider: protocol,
        baseURL: base || undefined,
        apiKey: key || undefined,
      });
      setRemote(models);
      if (models.length === 0) {
        setError(t("No models returned — check baseURL / apiKey"));
      }
    } catch (err) {
      setError(describeError(err));
      setRemote(null);
    } finally {
      setFetching(false);
    }
  };

  const toggleModel = (id: string): void => {
    setEnabled((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  };

  const save = async (): Promise<void> => {
    const id = (draft?.kind === "add" ? endpointId.trim() : draft?.id)?.trim();
    if (!id) {
      setError(t("Provider id is required"));
      return;
    }
    if (showBaseURL && !baseURL.trim()) {
      setError(t("baseURL is required for custom providers"));
      return;
    }
    if (enabled.length === 0) {
      setError(t("Select at least one model"));
      return;
    }
    const tmpl =
      draft?.kind === "add"
        ? snap?.templates.find((t) => t.id === draft.fromTemplate)
        : editing
          ? templateForEndpoint(snap!, editing.id, editing.saved)
          : snap?.templates.find((t) => t.id === id);
    const resolvedBase = showBaseURL
      ? baseURL.trim()
      : (tmpl?.baseURL ?? effectiveBaseURL());
    const preset: ConfigProviderPreset = {
      provider: protocol,
      displayName: displayName.trim() || tmpl?.displayName || id,
      baseURL: resolvedBase || undefined,
      apiKey: apiKey.trim() || undefined,
      model: defaultModel.trim() || enabled[0],
      smallModel: smallModel.trim() || undefined,
      models: enabled,
    };
    setBusy(true);
    try {
      await client.upsertProvider(id, preset);
      await reload();
      setDraft({ kind: "edit", id });
      setApiKey("");
      setRemote(null);
      cp.notify(t("Provider saved"));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (): Promise<void> => {
    if (!editing?.saved) {
      setError(t("Save the provider before setting it as default"));
      return;
    }
    setBusy(true);
    try {
      await client.setActiveProvider(editing.id, {
        model: editing.saved.model,
        sessionId: state.sessionId,
        persist: true,
      });
      await reload();
      cp.notify(`${t("Default")} → ${editing.displayName}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!editing) return;
    if (!window.confirm(t(`Remove saved config for “${editing.displayName}”?`))) return;
    setBusy(true);
    try {
      await client.deleteProvider(editing.id);
      const next = await reload();
      const first = next ? Object.keys(next.providers)[0] : undefined;
      setDraft(first ? { kind: "edit", id: first } : null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const catalog = remote ?? enabled;
  const localEndpoint = isLocalBaseURL(effectiveBaseURL());
  const canFetch =
    protocol === "copilot" ||
    localEndpoint ||
    apiKey.trim().length > 0 ||
    !!editing?.saved.hasApiKey;

  const vendorTemplates = (snap?.templates ?? []).filter(
    (tmpl) => !tmpl.requiresBaseURL && tmpl.provider !== "copilot",
  );
  const customTemplates = (snap?.templates ?? []).filter((tmpl) => !!tmpl.requiresBaseURL);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-3xl animate-fade-in flex-col border-l border-[var(--color-edge)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-4">
          <span className="text-[13.5px] font-semibold text-[var(--color-ink)]">{t("Settings")}</span>
          <span className="text-[11.5px] text-[var(--color-ink-faint)]">{t("Providers & models")}</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className="cp-icon-btn" title={t("Refresh")} onClick={() => void reload()}>
              <RefreshIcon className="h-4 w-4" />
            </button>
            <button type="button" className="cp-icon-btn" title={t("Close")} onClick={onClose}>
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 rounded-lg border border-[var(--color-remove)]/30 bg-[var(--color-remove)]/10 px-3 py-2 text-[12px] text-[var(--color-remove)]">
            {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex w-56 shrink-0 flex-col border-r border-[var(--color-edge-subtle)]">
            <div className="cp-eyebrow px-3 pt-3 pb-1">{t("Endpoints")}</div>
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
              {rows.length === 0 && (
                <div className="px-2 py-3 text-[11.5px] text-[var(--color-ink-faint)]">
                  {t("No endpoints yet — add one below.")}
                </div>
              )}
              {rows.map((r) => {
                const active = draft?.kind === "edit" && r.id === draft.id;
                const n = r.saved.models?.length ?? 0;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`mb-0.5 flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                      active
                        ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                        : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                    }`}
                    onClick={() => setDraft({ kind: "edit", id: r.id })}
                  >
                    <span className="truncate text-[12.5px] font-medium">{r.displayName}</span>
                    <span className="truncate text-[10.5px] text-[var(--color-ink-faint)]">
                      {r.provider}
                      {n ? ` · ${n} ${t("models")}` : ""}
                      {snap?.active.providerId === r.id ? ` · ${t("Default")}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="relative border-t border-[var(--color-edge-subtle)] p-2">
              <button
                type="button"
                className={`flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] ${
                  chooserOpen || draft?.kind === "add"
                    ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                    : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
                }`}
                onClick={() => setChooserOpen((v) => !v)}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {t("Add endpoint")}
              </button>
              {chooserOpen && (
                <div className="absolute bottom-full left-2 right-2 z-10 mb-1 max-h-72 overflow-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg">
                  <div className="cp-eyebrow px-3 pt-2 pb-1">{t("Built-in vendors")}</div>
                  {vendorTemplates.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      type="button"
                      className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-[var(--color-surface-hover)]"
                      onClick={() => beginFromTemplate(tmpl)}
                    >
                      <span className="text-[12px] text-[var(--color-ink)]">{tmpl.displayName}</span>
                      <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                        {t("Adds another key / endpoint")}
                      </span>
                    </button>
                  ))}
                  <div className="cp-eyebrow px-3 pt-2 pb-1">{t("Custom")}</div>
                  {(customTemplates.length > 0
                    ? customTemplates
                    : [
                        {
                          id: "custom-openai",
                          displayName: t("Custom (OpenAI protocol)"),
                          provider: "openai" as const,
                          requiresBaseURL: true,
                        },
                        {
                          id: "custom-anthropic",
                          displayName: t("Custom (Claude protocol)"),
                          provider: "anthropic" as const,
                          requiresBaseURL: true,
                        },
                      ]
                  ).map((tmpl) => (
                    <button
                      key={tmpl.id}
                      type="button"
                      className="flex w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
                      onClick={() => {
                        if (tmpl.provider === "openai" || tmpl.provider === "anthropic") {
                          beginCustom(tmpl.provider);
                        } else {
                          beginFromTemplate(tmpl as ProviderTemplateInfo);
                        }
                      }}
                    >
                      {tmpl.displayName}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1 overflow-auto p-4">
            {!draft ? (
              <div className="text-[12.5px] text-[var(--color-ink-faint)]">
                {t("Select an endpoint on the left, or add a new one.")}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="text-[14px] font-semibold text-[var(--color-ink)]">
                    {draft.kind === "add" ? t("New endpoint") : editing?.displayName}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-[var(--color-ink-faint)]">
                    {t("Each endpoint has its own key and model list; vendors are just presets.")}
                  </div>
                </div>

                {draft.kind === "add" && (
                  <Field
                    label={t("Id")}
                    value={endpointId}
                    onChange={setEndpointId}
                    placeholder="deepseek-work"
                    mono
                  />
                )}

                <Field
                  label={t("Display name")}
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder={editing?.displayName}
                />

                {showBaseURL && (
                  <label className="block">
                    <span className="cp-eyebrow">{t("Protocol")}</span>
                    <select
                      className="cp-input mt-0.5 w-full text-[12px]"
                      value={protocol}
                      onChange={(e) => setProtocol(e.target.value as ProviderKind)}
                    >
                      <option value="openai">{t("OpenAI protocol")}</option>
                      <option value="anthropic">{t("Claude protocol")}</option>
                      <option value="copilot">GitHub Copilot</option>
                    </select>
                  </label>
                )}

                {showBaseURL ? (
                  <Field
                    label="baseURL"
                    value={baseURL}
                    onChange={setBaseURL}
                    placeholder={
                      protocol === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.example.com/v1"
                    }
                    mono
                  />
                ) : (
                  <div className="rounded-lg border border-[var(--color-edge-subtle)] bg-[var(--color-bg)] px-3 py-2 text-[11.5px] text-[var(--color-ink-faint)]">
                    {t("Endpoint is built-in — no baseURL needed.")}
                    {effectiveBaseURL() && (
                      <div className="mt-0.5 font-mono text-[10.5px] opacity-80">
                        {effectiveBaseURL()}
                      </div>
                    )}
                  </div>
                )}

                <Field
                  label="apiKey"
                  value={apiKey}
                  onChange={setApiKey}
                  type="password"
                  mono
                  placeholder={
                    editing?.saved.hasApiKey
                      ? `····${editing.saved.apiKeyHint} (${t("leave blank to keep")})`
                      : t("Paste API key")
                  }
                />

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="cp-btn"
                    disabled={fetching || busy || !canFetch}
                    onClick={() => void fetchModels()}
                    title={!canFetch ? t("Enter an API key before fetching models") : undefined}
                  >
                    {fetching ? t("Fetching…") : t("Fetch models")}
                  </button>
                  <span className="text-[11px] text-[var(--color-ink-faint)]">
                    {t("Then tick the models you want in the picker.")}
                  </span>
                </div>

                <div>
                  <div className="cp-eyebrow mb-1.5">{t("Models")}</div>
                  <div className="max-h-56 overflow-auto rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-bg)] p-2">
                    {catalog.length === 0 ? (
                      <div className="px-2 py-3 text-[11.5px] text-[var(--color-ink-faint)]">
                        {!canFetch
                          ? t("Enter an API key, then fetch the real model list.")
                          : t("No models yet — click Fetch models, then tick what you want.")}
                      </div>
                    ) : (
                      catalog.map((m) => {
                        const on = enabled.includes(m);
                        return (
                          <label
                            key={m}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--color-surface-hover)]"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleModel(m)}
                              className="accent-[var(--color-accent)]"
                            />
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-ink)]">
                              {m}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  {enabled.length > 0 && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="cp-eyebrow">{t("Default model")}</span>
                        <select
                          className="cp-input mt-0.5 w-full font-mono text-[12px]"
                          value={defaultModel}
                          onChange={(e) => setDefaultModel(e.target.value)}
                        >
                          {enabled.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="cp-eyebrow">smallModel</span>
                        <select
                          className="cp-input mt-0.5 w-full font-mono text-[12px]"
                          value={smallModel}
                          onChange={(e) => setSmallModel(e.target.value)}
                        >
                          <option value="">—</option>
                          {enabled.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-edge-subtle)] pt-3">
                  {draft.kind === "edit" && editing && (
                    <>
                      <button
                        type="button"
                        className="cp-btn-ghost text-[var(--color-remove)]"
                        disabled={busy}
                        onClick={() => void remove()}
                      >
                        {t("Clear saved")}
                      </button>
                      {snap?.active.providerId !== editing.id && (
                        <button
                          type="button"
                          className="cp-btn-ghost"
                          disabled={busy}
                          onClick={() => void setDefault()}
                        >
                          {t("Set as default")}
                        </button>
                      )}
                    </>
                  )}
                  <button type="button" className="cp-btn" disabled={busy} onClick={() => void save()}>
                    {t("Save")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  mono?: boolean;
  type?: string;
  placeholder?: string;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="cp-eyebrow">{label}</span>
      <input
        type={type}
        className={`cp-input mt-0.5 w-full ${mono ? "font-mono text-[12px]" : ""}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
