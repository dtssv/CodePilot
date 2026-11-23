// Model / provider / mode / endpoint configuration surface. Extracted from Session (move-only split).

import type { AgentMode, CodepilotConfig, Event } from "../types.js";
import type { OutputStyle } from "../systemPrompt/index.js";
import type { PermissionEngine } from "../permissions/permissions.js";
import { ToolRegistry } from "../tools/types.js";
import { setPlanFileStatus } from "../subagent/plans.js";
import {
  resolveModelAlias,
  useProvider,
} from "../config/config.js";
import { applyProviderAndModel } from "../config/providerCatalog.js";

type SystemPromptCache = {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
  stableContext?: string;
  volatileSuffix?: string;
} | null;

export type ConfigHost = {
  disposed: boolean;
  cwd: string;
  mode: AgentMode;
  prePlanMode: AgentMode | null;
  lastPlanSlug: string | null;
  config: CodepilotConfig;
  model: string;
  activeProviderId: string | undefined;
  outputStyle: OutputStyle;
  hostSurface: "cli" | "tui" | "vscode" | "idea";
  turnOverrideModel: string | null;
  turnOverrideAllowedTools: string[] | null;
  turnOverrideRuleCount: number;
  systemPromptCache: SystemPromptCache;
  toolRegistry: ToolRegistry;
  events: Event[];
  lastProviderInputTokens: number;
  contextAnchor: { input: number; eventCount: number } | null;
  foldedToolResultStubs: Map<string, string>;
  permissions: PermissionEngine;
  rebuildSystemPrompt(opts?: { scope?: "full" | "volatile" }): Promise<void>;
  persistEvent(e: Event): Promise<void>;
  notify(e: Event): void;
};

/**
 * Re-evaluate the high-risk-model gate against the active model and tell the
 * permission engine whether to ignore persisted allow rules. Idempotent; call
 * whenever the model changes so a switch to (or away from) a high-risk model
 * tightens (or relaxes) matching immediately.
 */
export function applyHighRiskModelGate(host: ConfigHost): void {
  const list = host.config.highRiskModels ?? [];
  const model = (host.model ?? "").toLowerCase();
  const highRisk =
    !!model && list.some((m) => model.includes(m.toLowerCase()));
  host.permissions.setIgnorePersistedAllows(highRisk, {
    dropSessionAllows: host.config.highRiskDropSessionAllows,
  });
}

/**
 * Change the collaboration mode (agent / plan / chat). When the user
 * user enters `plan` mode, the previous mode is stashed in `prePlanMode`
 * so it can be restored on approval. When the agent calls `plan_done` and
 * the user approves, the session switches to `agent` mode (not back to
 * plan entry) — restore the pre-plan permission *tier*
 * but always lands in an executable mode. We mark the plan file
 * "approved" so the artifact reflects the outcome.
 */
export async function setAgentMode(host: ConfigHost, mode: AgentMode): Promise<void> {
  if (host.disposed) throw new Error("session disposed");
  if (host.mode === mode) return;
  // Stash the pre-plan mode so we can report it (and so the approval
  // handler knows we came from plan mode).
  if (mode === "plan" && host.mode !== "plan") {
    host.prePlanMode = host.mode;
  }
  // If we're leaving plan mode (the plan_done approval path), mark the
  // plan file approved regardless of whether we land in agent or restore
  // chat — the user accepted the plan either way.
  if (host.mode === "plan" && mode !== "plan" && host.lastPlanSlug) {
    await setPlanFileStatus(host.cwd, host.lastPlanSlug, "approved", {
      plansDirectory: host.config.plansDirectory,
    }).catch(() => undefined);
  }
  host.mode = mode;
  await host.rebuildSystemPrompt();
  const ev: Event = { type: "mode", mode };
  host.events.push(ev);
  await host.persistEvent(ev);
  host.notify(ev);
}

/** Returns the current collaboration mode (default "agent"). */
export function getAgentMode(host: ConfigHost): AgentMode {
  return host.mode;
}

/** Returns the current output style (default "concise"). */
export function getOutputStyle(host: ConfigHost): OutputStyle {
  return host.outputStyle;
}

/** Returns the active model (factoring in any turn-scoped override). */
export function getModel(host: ConfigHost): string {
  return host.turnOverrideModel ?? host.model;
}

/** Active named provider preset id (undefined when using flat config only). */
export function getProviderId(host: ConfigHost): string | undefined {
  return host.activeProviderId;
}

/** Snapshot of the runtime config (provider / baseURL / keys / models). */
export function getConfig(host: ConfigHost): CodepilotConfig {
  return { ...host.config, model: host.model };
}

/** Read-only view of the system prompt the session currently sends (built
 * on init and after each prompt). Null until first built. Useful for hosts
 * that surface the active prompt and for tests. */
export function getSystemPrompt(host: ConfigHost): {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
} | null {
  return host.systemPromptCache;
}

/**
 * Merge named provider presets into the live session config (e.g. after the
 * user saves providers in Settings while a session is already open).
 */
export function mergeProviders(
  host: ConfigHost,
  providers: Record<string, import("../config/config.js").ProviderPreset>,
): void {
  const cur = (host.config as import("../config/config.js").ResolvedCodepilotConfig).providers ?? {};
  host.config = {
    ...host.config,
    providers: { ...cur, ...providers },
  } as CodepilotConfig;
}

/**
 * Persistently switch the session model (optionally across providers).
 * When `providerId` is set, applies that preset first via `useProvider`.
 * Emits a `{ type: "model" }` event for UI clients.
 */
export async function setModel(
  host: ConfigHost,
  model: string,
  providerId?: string,
): Promise<void> {
  if (host.disposed) throw new Error("session disposed");
  if (!model) return;
  if (providerId) {
    await setEndpoint(host, { model, providerId });
    return;
  }
  const resolved = resolveModelAlias({ ...host.config, model }) ?? model;
  if (resolved === host.model && !providerId) return;
  // Apply per-model capabilities (contextWindow, maxOutputTokens) from the
  // provider's `modelCapabilities`, not just the model name — otherwise a
  // model-only switch keeps a stale window. `applyProviderAndModel` is a
  // no-op when no caps are configured.
  const applied = applyProviderAndModel(host.config, host.activeProviderId, resolved);
  host.model = applied.model;
  host.config = applied.config;
  if (applied.providerId) host.activeProviderId = applied.providerId;
  // A different model re-bills the whole prompt under its own tokeniser, so
  // the previous measurement no longer anchors the estimate.
  host.lastProviderInputTokens = 0;
  host.contextAnchor = null;
  host.foldedToolResultStubs.clear();
  applyHighRiskModelGate(host);
  await host.rebuildSystemPrompt();
  await emitModelEvent(host);
}

/**
 * Set reasoning / extended-thinking effort for subsequent turns.
 * Pass `undefined` (or call with no effort) to turn thinking off.
 * Clears any explicit `thinkingBudget` so effort mapping takes effect.
 */
export function setReasoningEffort(
  host: ConfigHost,
  effort: "low" | "medium" | "high" | undefined,
): void {
  if (host.disposed) throw new Error("session disposed");
  host.config = {
    ...host.config,
    reasoningEffort: effort,
    thinkingBudget: undefined,
  };
}

export function getReasoningEffort(
  host: ConfigHost,
): "low" | "medium" | "high" | undefined {
  return host.config.reasoningEffort;
}

/**
 * Switch to a named provider preset from `config.providers`. Optionally
 * override the model (defaults to the preset's `model`).
 */
export async function setProvider(
  host: ConfigHost,
  providerId: string,
  model?: string,
): Promise<void> {
  if (host.disposed) throw new Error("session disposed");
  const applied = useProvider(host.config, providerId);
  const nextModel =
    model ??
    applied.model ??
    host.model;
  await setEndpoint(host, { model: nextModel, providerId });
}

/**
 * Switch provider + model in one step (cross-vendor picker).
 */
export async function setEndpoint(
  host: ConfigHost,
  opts: {
    model: string;
    providerId?: string;
  },
): Promise<void> {
  if (host.disposed) throw new Error("session disposed");
  const { config, providerId, model } = applyProviderAndModel(
    host.config,
    opts.providerId,
    opts.model,
  );
  host.config = config;
  host.model = model;
  host.activeProviderId = providerId;
  // The endpoint/model changed → the prior provider measurement no longer
  // anchors the estimate.
  host.lastProviderInputTokens = 0;
  host.contextAnchor = null;
  host.foldedToolResultStubs.clear();
  applyHighRiskModelGate(host);
  await host.rebuildSystemPrompt();
  await emitModelEvent(host);
}

export async function emitModelEvent(host: ConfigHost): Promise<void> {
  const ev: Event = {
    type: "model",
    model: host.model,
    providerId: host.activeProviderId,
  };
  host.events.push(ev);
  await host.persistEvent(ev);
  host.notify(ev);
}

/**
 * Set turn-scoped overrides. The
 * `model` override (use `"inherit"` to keep the session model) and the
 * `allowedTools` permission grant apply to the NEXT `prompt` only and
 * are cleared in that prompt's finally block — so the session resumes
 * its normal model + permission posture on the user's next message.
 *
 * Calling this while a prompt is running is a no-op (the overrides would
 * be cleared by the in-flight prompt's finally before they take effect);
 * hosts should call it immediately before `prompt`.
 *
 * `allowedTools` entries are tool names (e.g. `["bash", "read_file"]`).
 * Each becomes an "allow" session rule for the next turn.
 */
export function setTurnOverrides(
  host: ConfigHost,
  opts: { model?: string; allowedTools?: string[] } = {},
): void {
  if (host.disposed) throw new Error("session disposed");
  // Clear any stale overrides first so we don't double-push rules.
  clearTurnOverrides(host);
  if (opts.model && opts.model !== "inherit") {
    host.turnOverrideModel = opts.model;
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    host.turnOverrideAllowedTools = opts.allowedTools.slice();
    host.turnOverrideRuleCount = opts.allowedTools.length;
    for (const toolName of opts.allowedTools) {
      host.permissions.addSessionRule(toolName, "allow");
    }
  }
}

/** Clear any active turn-scoped overrides (model + permission grants). */
export function clearTurnOverrides(host: ConfigHost): void {
  host.turnOverrideModel = null;
  if (host.turnOverrideAllowedTools) {
    // Pop exactly the N "allow" rules we pushed (LIFO), leaving any
    // "always"-decision rules intact.
    host.permissions.removeLastSessionRules("allow", host.turnOverrideRuleCount);
    host.turnOverrideAllowedTools = null;
    host.turnOverrideRuleCount = 0;
  }
}

/** Returns the currently-active turn-scoped overrides (for UI display). */
export function getTurnOverrides(host: ConfigHost): {
  model: string | null;
  allowedTools: string[] | null;
} {
  return {
    model: host.turnOverrideModel,
    allowedTools: host.turnOverrideAllowedTools,
  };
}

/**
 * Restrict the session's tool registry to only the named tools. Tools
 * not in the list are removed from the registry, so the model never
 * sees them and the agent loop cannot invoke them. This is a persistent
 * session-level filter (unlike turn-scoped overrides).
 *
 * Used by headless/print mode (`--allowed-tools`) to restrict the agent
 * to a subset of tools for CI/scripting safety.
 */
/** Names of the tools currently available to the model (after any
 * `filterToolRegistry`). Introspection for clients and tests. */
export function getToolNames(host: ConfigHost): string[] {
  return host.toolRegistry.all().map((t) => t.name);
}

export function filterToolRegistry(host: ConfigHost, allowedTools: string[]): void {
  const allowed = new Set(allowedTools);
  const allTools = host.toolRegistry.all();
  host.toolRegistry = new ToolRegistry();
  for (const t of allTools) {
    if (allowed.has(t.name)) {
      host.toolRegistry.register(t);
    }
  }
  // Rebuild the system prompt so the advertised tool list matches.
  void host.rebuildSystemPrompt();
}

/**
 * Switch the output style. Rebuilds the system prompt so the new style's
 * guidance reaches the model on the next turn. Does NOT emit an event —
 * output style is a presentation knob, not a behavioral mode.
 */
export async function setOutputStyle(host: ConfigHost, style: OutputStyle): Promise<void> {
  if (host.disposed) throw new Error("session disposed");
  if (host.outputStyle === style) return;
  host.outputStyle = style;
  // Output-style guidance rides the volatile Collaboration Modes block.
  await host.rebuildSystemPrompt({ scope: "volatile" });
}

/** Returns the host surface (default "cli"). */
export function getHostSurface(host: ConfigHost): "cli" | "tui" | "vscode" | "idea" {
  return host.hostSurface;
}

/**
 * Update the host surface. Call this when the session is attached to a
 * different frontend (e.g. a CLI session moved into the VSCode panel).
 * Rebuilds the prompt so platform-aware advice updates.
 */
export async function setHostSurface(
  host: ConfigHost,
  surface: "cli" | "tui" | "vscode" | "idea",
): Promise<void> {
  if (host.disposed) throw new Error("session disposed");
  if (host.hostSurface === surface) return;
  host.hostSurface = surface;
  await host.rebuildSystemPrompt();
}