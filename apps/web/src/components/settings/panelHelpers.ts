import type {
  ConfigProviderRedacted,
  ConfigSnapshot,
  ModelCapabilities,
  ModelModality,
  ProviderTemplateInfo,
  RemoteModelInfo,
} from "../../protocol/client.js";
import { t } from "../../i18n.js";
import type { EndpointRow, HeaderRow, ProviderKind, WireProtocol } from "./panelTypes.js";

export function wireFromSaved(
  provider: ProviderKind,
  apiStyle?: "chat" | "responses",
): WireProtocol {
  if (provider === "openai") {
    return apiStyle === "responses" ? "openai-responses" : "openai-chat";
  }
  if (provider === "gemini") return "gemini";
  if (provider === "copilot") return "copilot";
  if (provider === "azure") return "azure";
  return "anthropic";
}

export function providerFromWire(wire: WireProtocol): ProviderKind {
  if (wire === "openai-chat" || wire === "openai-responses") return "openai";
  return wire;
}

export function apiStyleFromWire(wire: WireProtocol): "chat" | "responses" | undefined {
  if (wire === "openai-responses") return "responses";
  if (wire === "openai-chat") return "chat";
  return undefined;
}

export function headersToRows(headers?: Record<string, string>): HeaderRow[] {
  if (!headers) return [];
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

export function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Always-available custom wire protocols (catalog cache may lag behind). */
export const FALLBACK_CUSTOM_TEMPLATES: ProviderTemplateInfo[] = [
  {
    id: "custom-openai",
    displayName: "Custom (OpenAI Chat Completions)",
    provider: "openai",
    apiStyle: "chat",
    requiresBaseURL: true,
  },
  {
    id: "custom-openai-responses",
    displayName: "Custom (OpenAI Responses)",
    provider: "openai",
    apiStyle: "responses",
    requiresBaseURL: true,
  },
  {
    id: "custom-anthropic",
    displayName: "Custom (Anthropic Messages)",
    provider: "anthropic",
    requiresBaseURL: true,
  },
  {
    id: "custom-gemini",
    displayName: "Custom (Google Gemini)",
    provider: "gemini",
    requiresBaseURL: true,
  },
];

export function mergeCustomTemplates(fromSnap: ProviderTemplateInfo[]): ProviderTemplateInfo[] {
  const map = new Map<string, ProviderTemplateInfo>();
  for (const t of FALLBACK_CUSTOM_TEMPLATES) map.set(t.id, t);
  for (const t of fromSnap) {
    if (!t.requiresBaseURL) continue;
    const prev = map.get(t.id);
    map.set(t.id, {
      ...prev,
      ...t,
      apiStyle: t.apiStyle ?? prev?.apiStyle,
    });
  }
  const ordered: ProviderTemplateInfo[] = [];
  const seen = new Set<string>();
  for (const t of FALLBACK_CUSTOM_TEMPLATES) {
    const cur = map.get(t.id);
    if (cur) {
      ordered.push(cur);
      seen.add(t.id);
    }
  }
  for (const [id, t] of map) {
    if (!seen.has(id)) ordered.push(t);
  }
  return ordered;
}

/** Localize known template labels; fall back to the catalog displayName. */
export function templateLabel(tmpl: { id: string; displayName: string }): string {
  const byId: Record<string, string> = {
    "custom-openai": "Custom (OpenAI Chat Completions)",
    "custom-openai-responses": "Custom (OpenAI Responses)",
    "custom-anthropic": "Custom (Anthropic Messages)",
    "custom-gemini": "Custom (Google Gemini)",
  };
  return t(byId[tmpl.id] ?? tmpl.displayName);
}

export const ALL_MODALITIES: ModelModality[] = ["text", "image", "audio", "video"];

/** Defaults when the gateway does not report limits. */
export const DEFAULT_CONTEXT = 200_000;
export const DEFAULT_MAX_OUTPUT = 32_000;

export function clampContext(value: number, max?: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n) || n < 1) {
    return max !== undefined ? Math.max(1, Math.floor(max)) : DEFAULT_CONTEXT;
  }
  if (max === undefined) return n;
  return Math.min(n, Math.max(1, Math.floor(max)));
}

export function formatContextTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

export function defaultCaps(_modelId: string, remote?: RemoteModelInfo): ModelCapabilities {
  const max = remote?.contextWindowMax;
  return {
    ...(max !== undefined ? { contextWindowMax: max } : {}),
    contextWindow: max ?? DEFAULT_CONTEXT,
    modalities: remote?.modalities?.length ? remote.modalities : ["text"],
    maxOutputTokens: remote?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
  };
}

export function mergeRemoteCaps(
  prev: Record<string, ModelCapabilities>,
  remote: RemoteModelInfo[],
): Record<string, ModelCapabilities> {
  const next = { ...prev };
  for (const m of remote) {
    const existing = prev[m.id];
    const max = m.contextWindowMax ?? existing?.contextWindowMax;
    let contextWindow =
      existing?.contextWindow ?? (max !== undefined ? max : DEFAULT_CONTEXT);
    if (max !== undefined) {
      contextWindow = clampContext(contextWindow, max);
    }
    next[m.id] = {
      ...(max !== undefined ? { contextWindowMax: max } : {}),
      contextWindow,
      modalities:
        existing?.modalities?.length
          ? existing.modalities
          : m.modalities?.length
            ? m.modalities
            : ["text"],
      maxOutputTokens:
        existing?.maxOutputTokens ??
        m.maxOutputTokens ??
        DEFAULT_MAX_OUTPUT,
    };
  }
  return next;
}

export function nextEndpointId(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const root = (base.trim() || "endpoint").replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!taken.has(root)) return root;
  let i = 2;
  while (taken.has(`${root}-${i}`)) i++;
  return `${root}-${i}`;
}

export function buildEndpointRows(snap: ConfigSnapshot | null): EndpointRow[] {
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

export function isLocalBaseURL(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

/** Match a saved endpoint back to a vendor template (exact id, `id-N` clone, or baseURL). */
export function templateForEndpoint(
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