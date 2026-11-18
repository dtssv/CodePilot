import { useCallback, useEffect, useMemo, useState } from "react";

import type { Codepilot } from "../../state/useCodepilot.js";
import type {
  ConfigProviderPreset,
  ConfigSnapshot,
  ModelCapabilities,
  ModelModality,
  ProviderTemplateInfo,
  RemoteModelInfo,
} from "../../protocol/client.js";
import { describeError } from "../../protocol/client.js";
import { t } from "../../i18n.js";
import { PlusIcon, RefreshIcon, XIcon } from "../Icons.js";
import type { Layout, Theme, ThemeName } from "../../surface.js";
import { SettingsExtras } from "./SettingsExtras.js";
import { Field } from "./SettingsField.js";
import type {
  DraftMode,
  EngineUpdateRow,
  HeaderRow,
  SettingsNav,
  WireProtocol,
} from "./panelTypes.js";
import {
  ALL_MODALITIES,
  DEFAULT_MAX_OUTPUT,
  apiStyleFromWire,
  buildEndpointRows,
  clampContext,
  defaultCaps,
  formatContextTokens,
  headersToRows,
  isLocalBaseURL,
  mergeCustomTemplates,
  mergeRemoteCaps,
  nextEndpointId,
  providerFromWire,
  rowsToHeaders,
  templateForEndpoint,
  templateLabel,
  wireFromSaved,
} from "./panelHelpers.js";

/** Provider + model settings drawer — endpoints are independent of vendor templates. */
export function SettingsPanel({
  cp,
  open,
  onClose,
  onComposePrompt,
  theme,
  onTheme,
  themeName,
  onThemeName,
  layout,
  onLayout,
}: {
  cp: Codepilot;
  open: boolean;
  onClose(): void;
  /** Prefill the main composer (e.g. skill-creator) and close settings. */
  onComposePrompt?: (text: string) => void;
  theme: Theme;
  onTheme(theme: Theme): void;
  themeName: ThemeName;
  onThemeName(name: ThemeName): void;
  layout: Layout;
  onLayout(layout: Layout): void;
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
  const [wire, setWire] = useState<WireProtocol>("openai-chat");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [showBaseURL, setShowBaseURL] = useState(true);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [smallModel, setSmallModel] = useState("");
  const [remote, setRemote] = useState<RemoteModelInfo[] | null>(null);
  const [caps, setCaps] = useState<Record<string, ModelCapabilities>>({});
  /** Model ids whose context/modality panel is expanded (collapsed by default). */
  const [expandedModels, setExpandedModels] = useState<Set<string>>(() => new Set());
  const [fetching, setFetching] = useState(false);
  const [engineUpdate, setEngineUpdate] = useState<EngineUpdateRow | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | undefined>();
  const [nav, setNav] = useState<SettingsNav>("general");
  const protocol = providerFromWire(wire);

  const rows = useMemo(() => buildEndpointRows(snap), [snap]);
  const editing = draft?.kind === "edit" ? rows.find((r) => r.id === draft.id) : null;

  const checkUpdates = useCallback(async (): Promise<void> => {
    if (state.connection !== "connected") return;
    setUpdateBusy(true);
    setUpdateMsg(undefined);
    try {
      const { engine } = await client.checkEngineUpdate();
      setEngineUpdate({
        current: engine.current,
        latest: engine.latest,
        available: engine.available,
        canAutoApply: engine.canAutoApply,
      });
      // Up-to-date is shown inline next to the button; clear prior messages.
      if (!engine.available) setUpdateMsg(undefined);
      else if (!engine.canAutoApply) {
        setUpdateMsg(t("Cannot auto-apply here (not a prefix install). Run: codepilot update"));
      }
    } catch (err) {
      setUpdateMsg(describeError(err));
    } finally {
      setUpdateBusy(false);
    }
  }, [client, state.connection]);

  const applyEngine = useCallback(async (): Promise<void> => {
    setUpdateBusy(true);
    setUpdateMsg(undefined);
    try {
      const r = await client.applyEngineUpdate();
      setUpdateMsg(r.message ?? (r.applied ? t("Restart CodePilot after updating the engine.") : undefined));
      if (r.applied) {
        setEngineUpdate((prev) =>
          prev
            ? { ...prev, current: r.version, available: false, latest: r.version }
            : { current: r.version, latest: r.version, available: false, canAutoApply: true },
        );
      }
    } catch (err) {
      setUpdateMsg(describeError(err));
    } finally {
      setUpdateBusy(false);
    }
  }, [client]);

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
    setExpandedModels(new Set());
    if (draft.kind === "add") {
      setEndpointId(draft.id);
      const tmpl =
        draft.fromTemplate && snap
          ? snap.templates.find((t) => t.id === draft.fromTemplate)
          : undefined;
      setWire(
        wireFromSaved(
          draft.provider,
          tmpl?.apiStyle ?? (draft.provider === "openai" ? "chat" : undefined),
        ),
      );
      setDisplayName(draft.displayName);
      setBaseURL(draft.baseURL);
      setShowBaseURL(draft.showBaseURL);
      setHeaderRows([]);
      setEnabled([]);
      setDefaultModel("");
      setSmallModel("");
      setCaps({});
      return;
    }
    if (!snap) return;
    const saved = snap.providers[draft.id];
    if (!saved) return;
    const tmpl = templateForEndpoint(snap, draft.id, saved);
    setEndpointId(draft.id);
    setWire(wireFromSaved(saved.provider, saved.apiStyle ?? tmpl?.apiStyle));
    setDisplayName(saved.displayName ?? tmpl?.displayName ?? draft.id);
    const needsBase = !tmpl || !!tmpl.requiresBaseURL;
    setShowBaseURL(needsBase);
    setBaseURL(saved.baseURL ?? tmpl?.baseURL ?? "");
    setHeaderRows(headersToRows(saved.headers));
    const models = saved.models?.length ? [...saved.models] : [];
    setEnabled(models);
    setDefaultModel(saved.model ?? "");
    setSmallModel(saved.smallModel ?? "");
    const nextCaps: Record<string, ModelCapabilities> = {};
    for (const [mid, c] of Object.entries(saved.modelCapabilities ?? {})) {
      nextCaps[mid] = {
        ...c,
        maxOutputTokens: c.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      };
    }
    for (const m of models) {
      if (!nextCaps[m]) nextCaps[m] = defaultCaps(m);
    }
    setCaps(nextCaps);
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
    const label = templateLabel(tmpl);
    setDraft({
      kind: "add",
      id,
      provider: tmpl.provider,
      displayName:
        existing.includes(tmpl.id) || existing.some((x) => x.startsWith(`${tmpl.id}-`))
          ? `${label} (${id})`
          : label,
      baseURL: tmpl.baseURL ?? "",
      showBaseURL: needsBase,
      fromTemplate: tmpl.id,
    });
    setWire(wireFromSaved(tmpl.provider, tmpl.apiStyle));
  };

  const beginCustom = (kind: WireProtocol): void => {
    const existing = snap ? Object.keys(snap.providers) : [];
    const provider = providerFromWire(kind);
    const base =
      kind === "openai-responses"
        ? "custom-openai-responses"
        : kind === "gemini"
          ? "custom-gemini"
          : kind === "anthropic"
            ? "custom-anthropic"
            : "custom-openai";
    const labels: Record<WireProtocol, string> = {
      "openai-chat": t("Custom (OpenAI Chat Completions)"),
      "openai-responses": t("Custom (OpenAI Responses)"),
      anthropic: t("Custom (Anthropic Messages)"),
      gemini: t("Custom (Google Gemini)"),
      copilot: t("GitHub Copilot"),
      azure: t("Azure OpenAI"),
    };
    const id = nextEndpointId(base, existing);
    setDraft({
      kind: "add",
      id,
      provider,
      displayName: labels[kind],
      baseURL: "",
      showBaseURL: true,
      fromTemplate: base,
    });
    setWire(kind);
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
        headers: rowsToHeaders(headerRows),
      });
      setRemote(models);
      setCaps((prev) => mergeRemoteCaps(prev, models));
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

  const ensureCaps = (id: string): ModelCapabilities => {
    const existing = caps[id];
    if (existing) return existing;
    const fromRemote = remote?.find((m) => m.id === id);
    return defaultCaps(id, fromRemote);
  };

  const toggleModel = (id: string): void => {
    if (enabled.includes(id)) {
      setEnabled(enabled.filter((m) => m !== id));
      return;
    }
    setEnabled([...enabled, id]);
    if (!caps[id]) {
      setCaps({ ...caps, [id]: defaultCaps(id, remote?.find((r) => r.id === id)) });
    }
  };

  const setModelContext = (id: string, value: number): void => {
    setCaps((prev) => {
      const cur = prev[id] ?? ensureCaps(id);
      return {
        ...prev,
        [id]: {
          ...cur,
          contextWindow: clampContext(value, cur.contextWindowMax),
        },
      };
    });
  };

  const setModelMaxOutput = (id: string, value: number): void => {
    const n = Math.floor(value);
    setCaps((prev) => {
      const cur = prev[id] ?? ensureCaps(id);
      return {
        ...prev,
        [id]: {
          ...cur,
          maxOutputTokens: Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT,
        },
      };
    });
  };

  const toggleModality = (id: string, modality: ModelModality): void => {
    if (modality === "text") return;
    setCaps((prev) => {
      const cur = prev[id] ?? ensureCaps(id);
      const has = cur.modalities.includes(modality);
      const modalities = has
        ? cur.modalities.filter((m) => m !== modality)
        : [...cur.modalities, modality];
      if (!modalities.includes("text")) modalities.unshift("text");
      return { ...prev, [id]: { ...cur, modalities } };
    });
  };

  const toggleExpanded = (id: string): void => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    const modelCapabilities: Record<string, ModelCapabilities> = {};
    for (const modelId of enabled) {
      modelCapabilities[modelId] = caps[modelId] ?? ensureCaps(modelId);
    }
    const style = apiStyleFromWire(wire);
    const preset: ConfigProviderPreset = {
      provider: protocol,
      displayName: displayName.trim() || tmpl?.displayName || id,
      baseURL: resolvedBase || undefined,
      apiKey: apiKey.trim() || undefined,
      model: defaultModel.trim() || enabled[0],
      smallModel: smallModel.trim() || undefined,
      models: enabled,
      modelCapabilities,
      ...(style ? { apiStyle: style } : {}),
      headers: rowsToHeaders(headerRows),
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
    if (!window.confirm(`${t("Remove saved config for")} “${editing.displayName}”?`)) return;
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

  const catalogIds = (() => {
    const ids = new Set<string>();
    if (remote) for (const m of remote) ids.add(m.id);
    for (const m of enabled) ids.add(m);
    return [...ids].sort((a, b) => a.localeCompare(b));
  })();
  const localEndpoint = isLocalBaseURL(effectiveBaseURL());
  const canFetch =
    protocol === "copilot" ||
    localEndpoint ||
    apiKey.trim().length > 0 ||
    !!editing?.saved.hasApiKey;

  const vendorTemplates = (snap?.templates ?? []).filter(
    (tmpl) => !tmpl.requiresBaseURL && tmpl.provider !== "copilot",
  );
  const customTemplates = mergeCustomTemplates(snap?.templates ?? []);
  // IDE sidebar/tool-window: full-bleed sheet over the chat (no new IDE tab),
  // stacked models panes so the narrow width stays usable — same store as Desktop.
  const sheet = layout === "embedded";
  const fill = sheet;

  return (
    <div
      className={
        fill
          ? "fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]"
          : "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
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
        aria-label={t("Settings")}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-edge-subtle)] px-3 sm:px-4">
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-[var(--color-ink)]">{t("Settings")}</div>
            <div className="truncate text-[10.5px] text-[var(--color-ink-faint)]">
              {t("Saved to ~/.codepilot/config.json")}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className="cp-icon-btn" title={t("Refresh")} onClick={() => void reload()}>
              <RefreshIcon className="h-4 w-4" />
            </button>
            <button type="button" className="cp-icon-btn" title={t("Close")} onClick={onClose}>
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-edge-subtle)] px-3 py-2">
          {(
            [
              ["general", t("General")],
              ["models", t("Models")],
              ["connectors", t("Connectors")],
              ["custom-mcp", t("Custom connectors")],
              ["plugins", t("Plugins")],
              ["skills", t("Skills")],
              ["remote", t("Remote")],
              ["schedule", t("Schedule")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`shrink-0 rounded-lg px-2.5 py-1 text-[12px] ${
                nav === id
                  ? "bg-[var(--color-accent-dim)] text-[var(--color-ink)]"
                  : "text-[var(--color-ink-dim)] hover:bg-[var(--color-surface-hover)]"
              }`}
              onClick={() => setNav(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error && nav === "models" && (
          <div className="mx-4 mt-3 shrink-0 rounded-lg border border-[var(--color-remove)]/30 bg-[var(--color-remove)]/10 px-3 py-2 text-[12px] text-[var(--color-remove)]">
            {error}
          </div>
        )}

        {nav !== "models" ? (
          <SettingsExtras
            cp={cp}
            section={nav}
            theme={theme}
            onTheme={onTheme}
            themeName={themeName}
            onThemeName={onThemeName}
            layout={layout}
            onLayout={onLayout}
            onComposePrompt={(text) => {
              onComposePrompt?.(text);
              onClose();
            }}
          />
        ) : (
        <div className={`flex min-h-0 flex-1 ${sheet ? "flex-col" : ""}`}>
          <div
            className={
              sheet
                ? "flex max-h-[38%] shrink-0 flex-col border-b border-[var(--color-edge-subtle)]"
                : "flex w-56 shrink-0 flex-col border-r border-[var(--color-edge-subtle)]"
            }
          >
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
                <div
                  className={
                    sheet
                      ? "absolute left-2 right-2 top-full z-10 mt-1 max-h-56 overflow-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
                      : "absolute bottom-full left-2 right-2 z-10 mb-1 max-h-72 overflow-auto rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface-raised)] py-1 shadow-lg"
                  }
                >
                  <div className="cp-eyebrow px-3 pt-2 pb-1">{t("Built-in vendors")}</div>
                  {vendorTemplates.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      type="button"
                      className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-[var(--color-surface-hover)]"
                      onClick={() => beginFromTemplate(tmpl)}
                    >
                      <span className="text-[12px] text-[var(--color-ink)]">
                        {templateLabel(tmpl)}
                      </span>
                      <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                        {t("Adds another key / endpoint")}
                      </span>
                    </button>
                  ))}
                  <div className="cp-eyebrow px-3 pt-2 pb-1">{t("Custom")}</div>
                  {customTemplates.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      type="button"
                      className="flex w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
                      onClick={() => beginFromTemplate(tmpl)}
                    >
                      {templateLabel(tmpl)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={`min-w-0 flex-1 overflow-auto ${sheet ? "p-3" : "p-4"}`}>
            {!draft ? (
              <div className="text-[12.5px] text-[var(--color-ink-faint)]">
                {sheet
                  ? t("Select an endpoint above, or add a new one.")
                  : t("Select an endpoint on the left, or add a new one.")}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="text-[14px] font-semibold text-[var(--color-ink)]">
                    {draft.kind === "add" ? t("New endpoint") : editing?.displayName}
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
                      value={wire}
                      onChange={(e) => setWire(e.target.value as WireProtocol)}
                    >
                      <option value="openai-chat">{t("OpenAI Chat Completions")}</option>
                      <option value="openai-responses">{t("OpenAI Responses")}</option>
                      <option value="anthropic">{t("Anthropic Messages")}</option>
                      <option value="gemini">{t("Google Gemini")}</option>
                      <option value="copilot">{t("GitHub Copilot")}</option>
                      <option value="azure">{t("Azure OpenAI")}</option>
                    </select>
                  </label>
                )}

                {showBaseURL ? (
                  <Field
                    label={t("baseURL")}
                    value={baseURL}
                    onChange={setBaseURL}
                    placeholder={
                      wire === "anthropic"
                        ? "https://host/inference/anthropic"
                        : wire === "gemini"
                          ? "https://host/inference/google/v1beta"
                          : wire === "openai-responses" || wire === "openai-chat"
                            ? "https://host/inference/openai/v1"
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
                  label={t("apiKey")}
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

                {showBaseURL && (
                  <div>
                    <div className="cp-eyebrow mb-1">{t("Request headers")}</div>
                    <div className="space-y-1.5">
                      {headerRows.map((row, i) => (
                        <div key={i} className="flex gap-1.5">
                          <input
                            className="cp-input min-w-0 flex-1 font-mono text-[11px]"
                            value={row.key}
                            placeholder="Header-Name"
                            onChange={(e) => {
                              const next = [...headerRows];
                              next[i] = { ...row, key: e.target.value };
                              setHeaderRows(next);
                            }}
                          />
                          <input
                            className="cp-input min-w-0 flex-[1.4] font-mono text-[11px]"
                            value={row.value}
                            placeholder="value"
                            onChange={(e) => {
                              const next = [...headerRows];
                              next[i] = { ...row, value: e.target.value };
                              setHeaderRows(next);
                            }}
                          />
                          <button
                            type="button"
                            className="cp-btn shrink-0 px-2"
                            onClick={() =>
                              setHeaderRows(headerRows.filter((_, j) => j !== i))
                            }
                            title={t("Remove")}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="cp-btn text-[11px]"
                        onClick={() =>
                          setHeaderRows([...headerRows, { key: "", value: "" }])
                        }
                      >
                        {t("Add header")}
                      </button>
                    </div>
                    <div className="mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
                      {t("Optional. Merged into every request (auth still wins).")}
                    </div>
                  </div>
                )}

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
                  <div className="max-h-72 overflow-auto rounded-xl border border-[var(--color-edge-subtle)] bg-[var(--color-bg)] p-2">
                    {catalogIds.length === 0 ? (
                      <div className="px-2 py-3 text-[11.5px] text-[var(--color-ink-faint)]">
                        {!canFetch
                          ? t("Enter an API key, then fetch the real model list.")
                          : t("No models yet — click Fetch models, then tick what you want.")}
                      </div>
                    ) : (
                      catalogIds.map((m) => {
                        const on = enabled.includes(m);
                        const expanded = expandedModels.has(m);
                        const c = on ? (caps[m] ?? ensureCaps(m)) : undefined;
                        return (
                          <div
                            key={m}
                            className="rounded-md px-2 py-1 hover:bg-[var(--color-surface-hover)]"
                          >
                            <div className="flex items-center gap-1.5">
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
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
                              {on && (
                                <button
                                  type="button"
                                  className="shrink-0 rounded p-0.5 text-[var(--color-ink-faint)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
                                  aria-expanded={expanded}
                                  title={expanded ? t("Collapse") : t("Expand")}
                                  onClick={() => toggleExpanded(m)}
                                >
                                  <svg
                                    className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.75"
                                    aria-hidden
                                  >
                                    <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </button>
                              )}
                            </div>
                            {on && expanded && c && (
                              <div className="ml-6 mt-1 mb-1 space-y-1.5 border-l border-[var(--color-edge-subtle)] pl-2.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                                    {t("Context window")}
                                  </span>
                                  <input
                                    type="number"
                                    className="cp-input w-28 font-mono text-[11px]"
                                    min={1}
                                    max={c.contextWindowMax}
                                    value={c.contextWindow}
                                    onChange={(e) =>
                                      setModelContext(m, Number(e.target.value))
                                    }
                                  />
                                  {c.contextWindowMax !== undefined && (
                                    <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                                      / {formatContextTokens(c.contextWindowMax)}{" "}
                                      {t("max (provider)")}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                                    {t("Max output tokens")}
                                  </span>
                                  <input
                                    type="number"
                                    className="cp-input w-28 font-mono text-[11px]"
                                    min={1}
                                    value={c.maxOutputTokens ?? DEFAULT_MAX_OUTPUT}
                                    onChange={(e) =>
                                      setModelMaxOutput(m, Number(e.target.value))
                                    }
                                  />
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[10.5px] text-[var(--color-ink-faint)]">
                                    {t("Modalities")}
                                  </span>
                                  {ALL_MODALITIES.map((mod) => (
                                    <label
                                      key={mod}
                                      className="flex items-center gap-1 text-[11px] text-[var(--color-ink-dim)]"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={c.modalities.includes(mod)}
                                        disabled={mod === "text"}
                                        onChange={() => toggleModality(m, mod)}
                                        className="accent-[var(--color-accent)]"
                                      />
                                      {t(mod)}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
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
        )}

        {nav === "models" && (
        <div className="shrink-0 border-t border-[var(--color-edge-subtle)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="cp-btn-ghost py-0.5 text-[11.5px]"
              disabled={updateBusy || state.connection !== "connected"}
              onClick={() => void checkUpdates()}
            >
              <RefreshIcon className="h-3 w-3" />
              {updateBusy ? t("Checking…") : t("Check for updates")}
            </button>
            {engineUpdate && !engineUpdate.available && (
              <span className="text-[11.5px] text-[var(--color-add)]">{t("Up to date")}</span>
            )}
            {engineUpdate?.available && engineUpdate.latest && (
              <>
                <span className="font-mono text-[11.5px] text-[var(--color-ink-dim)]">
                  {engineUpdate.current} → {engineUpdate.latest}
                </span>
                <button
                  type="button"
                  className="cp-btn py-0.5 text-[11.5px]"
                  disabled={updateBusy || !engineUpdate.canAutoApply}
                  onClick={() => void applyEngine()}
                  title={
                    engineUpdate.canAutoApply
                      ? undefined
                      : t("Cannot auto-apply here (not a prefix install). Run: codepilot update")
                  }
                >
                  {t("Confirm update")}
                </button>
              </>
            )}
          </div>
          {updateMsg && (
            <div className="mt-1.5 text-[11.5px] text-[var(--color-ink-dim)]">{updateMsg}</div>
          )}
        </div>
        )}
        </div>
      </div>
    </div>
  );
}
