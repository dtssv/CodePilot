// Context gauge and public compaction controls. Extracted from Session (move-only split).

import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  decideLazyMcp,
  buildProviderMessages,
  buildProviderToolDefs,
} from "../agent/agent-messages.js";
import {
  compactionGeometry,
  DEFAULT_COMPACTION_FRACTION,
  estimateEventTokens,
  FORCED_SHRINK_RATIO,
  mergeCompactInstructions,
  renderTranscriptArchive,
  shouldCompact,
} from "./compaction.js";
import { estimateTokens, lookupContextWindow } from "./tokens.js";
import type { CompactionResult } from "./compaction.js";
import { filterToolsByModeFromRegistry, filterToolsByModel } from "../tools/index.js";
import { zodToJsonSchema, type ToolRegistry } from "../tools/types.js";
import type { ChatProvider } from "../providers/types.js";
import type { AgentMode, CodepilotConfig, Event } from "../types.js";
import type { HookEngine } from "../hooks/hooks.js";
import { buildProvider } from "../session/session-utils.js";
import { historyArchivePath } from "../session/session-utils.js";
import {
  DEFAULT_AUTOCOMPACT_MAX_FAILURES,
  TASK_BOUNDARY_MARKER,
  extractSkillsSection,
} from "../session/session-helpers.js";

type SystemPromptCache = {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
  stableContext?: string;
  volatileSuffix?: string;
} | null;

export type CompactHost = {
  id: string;
  disposed: boolean;
  model: string;
  config: CodepilotConfig;
  events: Event[];
  persisted: Event[];
  lastProviderInputTokens: number;
  contextAnchor: { input: number; eventCount: number } | null;
  systemPromptCache: SystemPromptCache;
  toolRegistry: ToolRegistry;
  mode: AgentMode;
  providerOverride: ChatProvider | undefined;
  hooks: HookEngine;
  maybeCompact(opts?: { force?: boolean; focus?: string }): Promise<void>;
  runCompaction(
    trigger: number,
    force: boolean,
    extraInstructions?: string,
    hasFocus?: boolean,
  ): Promise<CompactionResult>;
  persistEvent(e: Event): Promise<void>;
  notify(e: Event): void;
  rebuildSystemPrompt(): Promise<void>;
  autoCompactDisabled: boolean;
  compactFailStreak: number;
  compactNoopStreak: number;
  contextChangedForNextTurn: boolean;
  precompact: { fingerprint: string; result: CompactionResult } | null;
  loadCompactInstructions(): Promise<string | undefined>;
  newCompactionEvents(events: Event[]): Event[];
  compactionKeepFrom(events: Event[]): number;
  restoreDroppedFiles(dropped: Event[], retained: Event[], window: number): Promise<string>;
  recordCompactionFailure(trigger: number, reason: string, force: boolean): void;
  tripAutoCompactBreaker(
    reason: string,
    detail: { streak: number; before: number; after: number },
  ): void;
};

/**
 * Hybrid estimate of the tokens the NEXT send will cost. Prefers the
 * provider's last measured prompt size as an anchor and adds a heuristic
 * estimate for only the events appended after that measurement, so a large
 * tool_result produced this turn (before the next response) is reflected
 * immediately. With no anchor (before the first response, or just after a
 * model switch / compaction) `fallback` stands in. Shared by `contextReport`
 * (gauge) and `ensureContextUnderWindow` (compaction precheck) so both read
 * the same number.
 */
export function effectiveContextTokens(host: CompactHost, fallback: number): number {
  const anchor = host.contextAnchor;
  if (anchor && anchor.input > 0) {
    const trailing = host.events.slice(anchor.eventCount);
    const trailingTokens =
      trailing.length > 0 ? estimateEventTokens(trailing, estimateTokens) : 0;
    return anchor.input + trailingTokens;
  }
  const providerInputTokens = Math.max(0, host.lastProviderInputTokens);
  return providerInputTokens > 0 ? providerInputTokens : fallback;
}

/**
 * Produce a structured breakdown of the session's context usage for the
 * `/context` command. Returns total estimated tokens, a per-event-type
 * breakdown, the context window + trigger threshold, usage %, and a list
 * of files that have been read more than once (dedup hint).
 */
export function contextReport(host: CompactHost): {
  totalTokens: number;
  sentTokens: number;
  providerInputTokens: number;
  window: number;
  triggerThreshold: number;
  triggerFraction: number;
  usagePercent: number;
  autoCompactEnabled: boolean;
  byEventType: { type: string; tokens: number; count: number }[];
  byCategory: { category: string; tokens: number; isDeferred?: boolean }[];
  topFileReads: { path: string; reads: number; tokens: number }[];
  duplicateReads: { path: string; reads: number }[];
} {
  const modelWindow = lookupContextWindow(host.model);
  const window = host.config.contextWindow ?? modelWindow.contextWindow;
  // Use the SAME geometry as the real compaction path (`maybeCompact`), which
  // reserves output tokens — so the displayed trigger line matches where
  // compaction actually fires, not a plain `window × fraction`.
  const geometry = compactionGeometry({
    window,
    thresholdFraction: host.config.compactionThreshold,
    maxTokens: host.config.maxTokens,
    maxOutputTokens: modelWindow.maxOutputTokens,
  });
  const trigger = geometry.hardTrigger;
  const fraction = host.config.compactionThreshold ?? DEFAULT_COMPACTION_FRACTION;
  const byType = new Map<string, { tokens: number; count: number }>();
  let total = 0;
  // Track file reads for dedup hints.
  const fileReads = new Map<string, { reads: number; tokens: number }>();
  for (const e of host.events) {
    const tok = estimateEventTokens([e], estimateTokens);
    total += tok;
    const key = e.type;
    const cur = byType.get(key) ?? { tokens: 0, count: 0 };
    cur.tokens += tok;
    cur.count += 1;
    byType.set(key, cur);
    // read_file tool_call carries the path in input.path.
    if (e.type === "tool_call" && (e as { name?: string }).name === "read_file") {
      const inp = (e as { input?: { path?: string } }).input;
      const p = inp?.path;
      if (typeof p === "string") {
        const fr = fileReads.get(p) ?? { reads: 0, tokens: 0 };
        fr.reads += 1;
        fr.tokens += tok;
        fileReads.set(p, fr);
      }
    }
  }
  const byEventType = [...byType.entries()]
    .map(([type, v]) => ({ type, tokens: v.tokens, count: v.count }))
    .sort((a, b) => b.tokens - a.tokens);

  // Semantic breakdown: what KIND of content fills the window, not just the
  // event type. The system prompt + tool/MCP schemas are sent every turn but
  // live outside the event log, so they must be estimated separately. The
  // event-log total above is the "conversation/subagent" side.
  const sp = host.systemPromptCache;
  // The <skills> catalogue sits inside the stable system-prompt section; when
  // present, count it under its own category and subtract it from `system`.
  const skillsSection = sp ? extractSkillsSection(sp.full) : "";
  const skillsTokens = skillsSection ? estimateTokens(skillsSection) : 0;
  const systemTokens = sp
    ? Math.max(0, estimateTokens(sp.full) - skillsTokens)
    : 0;
  // Surface the last user turn separately so the breakdown can show
  // "this message vs. everything before it".
  let lastMessageTokens = 0;
  for (let i = host.events.length - 1; i >= 0; i--) {
    const e = host.events[i]!;
    if (e.type === "message" && e.role === "user") {
      lastMessageTokens = estimateEventTokens([e], estimateTokens);
      break;
    }
  }
  // Tool definitions sent to the provider this mode. Split MCP out — its
  // schemas are often the biggest and most surprising contributor. When lazy
  // MCP discovery is active, the individual MCP schemas are NOT sent (only the
  // `mcp` meta-tool is); account for those deferred schemas in a separate
  // bucket that is visible but does not count toward the context total.
  let toolTokens = 0;
  let mcpTokens = 0;
  let mcpDeferredTokens = 0;
  let pluginDeferredTokens = 0;
  const mcpToolCount = host.toolRegistry.all().filter((t) => t.source === "mcp").length;
  const lazyMcp = decideLazyMcp(
    mcpToolCount,
    host.config.mcpToolDiscovery,
    host.config.mcpLazyThreshold,
  );
  const pluginToolCount = host.toolRegistry.all().filter((t) => t.source === "plugin").length;
  const lazyPlugin = decideLazyMcp(
    pluginToolCount,
    host.config.pluginToolDiscovery ?? "eager",
    host.config.pluginLazyThreshold,
  );
  // Start mode-filtered (keeps MCP/plugin tools visible so the deferred buckets
  // can be estimated), then apply the per-model toolExposure downgrade so a
  // tool the provider request drops is not counted toward the send total.
  let visibleTools = filterToolsByModeFromRegistry(host.toolRegistry, host.mode);
  if (host.config.toolExposure && host.config.toolExposure.length > 0) {
    visibleTools = filterToolsByModel(visibleTools, host.model, host.config.toolExposure);
  }
  for (const t of visibleTools) {
    const def = {
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    };
    const tok = estimateTokens(JSON.stringify(def));
    if (t.source === "mcp") {
      // Under lazy discovery these schemas ride the `mcp` meta-tool on demand,
      // not the per-turn request, so they are deferred (shown, not counted).
      if (lazyMcp) mcpDeferredTokens += tok;
      else mcpTokens += tok;
    } else if (t.source === "plugin") {
      // Under lazy plugin discovery these ride the `tool_catalog` meta-tool on
      // demand, so they are deferred (shown, not counted toward the total).
      if (lazyPlugin) pluginDeferredTokens += tok;
      else toolTokens += tok;
    } else {
      toolTokens += tok;
    }
  }
  // Event-log tokens split into conversation vs sub-agent work.
  let subagentTokens = 0;
  let conversationTokens = 0;
  for (const e of host.events) {
    const tok = estimateEventTokens([e], estimateTokens);
    if (e.type === "subagent") subagentTokens += tok;
    else conversationTokens += tok;
  }
  // Split the current user message out of the conversation bucket so the two
  // don't double-count. `lastMessage` only counts when it is genuinely part
  // of the (non-subagent) conversation total.
  const conversationRest = Math.max(0, conversationTokens - lastMessageTokens);
  const byCategory: { category: string; tokens: number; isDeferred?: boolean }[] = [
    { category: "system", tokens: systemTokens },
    { category: "skills", tokens: skillsTokens },
    { category: "tools", tokens: toolTokens },
    { category: "mcp", tokens: mcpTokens },
    // Deferred MCP schemas: reachable via the `mcp` meta-tool on demand, not
    // sent each turn — shown for visibility but excluded from the total.
    { category: "mcp_deferred", tokens: mcpDeferredTokens, isDeferred: true },
    // Deferred plugin schemas: reachable via the `tool_catalog` meta-tool on
    // demand — shown for visibility but excluded from the total.
    { category: "plugin_deferred", tokens: pluginDeferredTokens, isDeferred: true },
    { category: "conversation", tokens: conversationRest },
    { category: "lastMessage", tokens: lastMessageTokens },
    { category: "subagent", tokens: subagentTokens },
  ]
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const topFileReads = [...fileReads.entries()]
    .map(([path, v]) => ({ path, reads: v.reads, tokens: v.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);
  const duplicateReads = topFileReads
    .filter((f) => f.reads > 1)
    .map((f) => ({ path: f.path, reads: f.reads }));
  // `sentTokens` is the accurate per-turn send estimate: event-log tokens
  // PLUS the fixed cost of the system prompt + skills + tool/MCP schemas,
  // which ride every request but live outside the event log. The gauge
  // percentage is driven by this grand total — the plain event-log `total`
  // understates real usage by that fixed cost.
  const sentTokens = total + systemTokens + skillsTokens + toolTokens + mcpTokens;
  // Hybrid estimate shared with the compaction precheck: measured anchor plus
  // an estimate for only the events appended after it (so a large tool_result
  // produced this turn is reflected immediately), falling back to the full
  // `sentTokens` estimate when there is no anchor.
  const providerInputTokens = Math.max(0, host.lastProviderInputTokens);
  const effectiveTotal = effectiveContextTokens(host, sentTokens);
  return {
    // Kept for back-compat: the event-log-only total some callers rely on.
    totalTokens: total,
    // The full per-turn send estimate (event log + system + tools + MCP).
    sentTokens,
    // Provider-reported prompt size from the last request (0 until the first
    // response), the most accurate numerator when available.
    providerInputTokens,
    window,
    triggerThreshold: trigger,
    triggerFraction: fraction,
    usagePercent: window > 0 ? Math.round((effectiveTotal / window) * 100) : 0,
    autoCompactEnabled: host.config.autoCompact !== false,
    byEventType,
    byCategory,
    topFileReads,
    duplicateReads,
  };
}

/**
 * Exact prompt token count via the provider's count-tokens API, for the
 * `/context --precise` opt-in. Gated behind `context.preciseCount: "on-demand"`
 * and the provider actually implementing `countTokens` (Anthropic). Builds the
 * same request the next turn would send (system + tools + folded history) and
 * returns the measured input tokens, or `null` when precise counting is off,
 * unsupported, or the call fails — callers fall back to the heuristic gauge.
 * Never runs automatically and never feeds the compaction threshold.
 */
export async function preciseContextCount(
  host: CompactHost,
): Promise<{ inputTokens: number } | null> {
  if (host.disposed) return null;
  if (host.config.context?.preciseCount !== "on-demand") return null;
  const provider = host.providerOverride ?? buildProvider(host.config);
  if (typeof provider.countTokens !== "function") return null;
  try {
    if (!host.systemPromptCache) {
      await host.rebuildSystemPrompt().catch(() => undefined);
    }
    const sp = host.systemPromptCache;
    const systemPrompt = sp?.full ?? undefined;
    const messages = buildProviderMessages(host.events, [], "");
    const lazyMcp = decideLazyMcp(
      host.toolRegistry.all().filter((t) => t.source === "mcp").length,
      host.config.mcpToolDiscovery,
      host.config.mcpLazyThreshold,
    );
    const tools = buildProviderToolDefs(host.toolRegistry, host.mode, {
      lazyMcp,
      model: host.model,
      toolExposure: host.config.toolExposure,
    });
    const res = await provider.countTokens({
      model: host.model,
      systemPrompt,
      messages,
      tools,
    });
    return { inputTokens: res.inputTokens };
  } catch {
    return null;
  }
}

export async function sessionMaybeCompact(
  host: CompactHost,
  opts: { force?: boolean; focus?: string } = {},
): Promise<void> {
 // Master toggle: when autoCompact is explicitly false, the session
 // never auto-compacts (the user must invoke /compact manually).
  if (host.config.autoCompact === false) return;
  const force = opts.force === true;
  // Circuit breaker: once auto-compaction has thrashed, stop auto attempts so
  // we don't burn API calls in a compact→still-full→compact loop. A manual
  // `/compact` (force) always runs and can clear the breaker.
  if (host.autoCompactDisabled && !force) return;
  const modelWindow = lookupContextWindow(host.model);
  const window = host.config.contextWindow ?? modelWindow.contextWindow;
 // Effective trigger point via the shared geometry (single source of truth
 // for every compaction coefficient). The compaction engine's `contextWindow`
 // option IS the trigger threshold (it compacts when tokens >= that value).
 // `hardTrigger` already reserves output tokens so we never wait until the
 // provider rejects the request.
  const trigger = compactionGeometry({
    window,
    thresholdFraction: host.config.compactionThreshold,
    maxTokens: host.config.maxTokens,
    maxOutputTokens: modelWindow.maxOutputTokens,
  }).hardTrigger;
  if (!force) {
    const decision = shouldCompact(host.events, { contextWindow: trigger });
    if (!decision.shouldCompact) return;
  }
  // Compact instructions: what the summary MUST preserve. Sourced from the
  // project memory's `## Compact Instructions` section, a per-invocation
  // `/compact <focus…>` argument, and (below) a PreCompact hook. The trigger
  // literal reflects whether this is a manual `/compact` (force) or the
  // threshold-driven auto path.
  const hookTrigger: "manual" | "auto" = force ? "manual" : "auto";
  const projectInstructions = await host.loadCompactInstructions();
  const fileAndFocus = mergeCompactInstructions({
    project: projectInstructions,
    focus: opts.focus,
  });
 // PreCompact hooks may block compaction (e.g. to preserve state during
 // a long-running task). They also receive the file+focus instructions and
 // may return their own `additionalInstructions` to fold in.
  const pre = await host.hooks.runPreCompact(hookTrigger, fileAndFocus).catch(() => ({
    action: "allow" as const,
    warnings: [],
  }));
  if (pre.action === "block") {
    process.stderr.write(
      `[session] compaction blocked by PreCompact hook: ${pre.reason ?? "(no reason)"}\n`
    );
    return;
  }
  const extraInstructions = mergeCompactInstructions({
    project: projectInstructions,
    focus: opts.focus,
    hook: (pre as { additionalInstructions?: string }).additionalInstructions,
  });
  let result: CompactionResult;
  try {
    result = await host.runCompaction(
      trigger,
      force,
      extraInstructions,
      !!(opts.focus && opts.focus.trim().length > 0),
    );
  } catch (err) {
    // A thrown compaction counts as a failure toward the breaker. Manual
    // compaction surfaces the error to the caller; auto swallows it (the run
    // continues, possibly oversize, and the breaker may trip).
    host.recordCompactionFailure(trigger, `error: ${(err as Error).message}`, force);
    if (force) throw err;
    return;
  }
  if (result.events === host.events) {
    // No change: compaction could not shrink anything. Treated as a failure
    // so a genuinely stuck transcript trips the breaker instead of looping.
    host.recordCompactionFailure(trigger, "no-change", force);
    return;
  }
  // The prompt prefix just changed, so the next turn's input re-bill is
  // expected content, not broken caching — flag it for cache-waste attribution.
  host.contextChangedForNextTurn = true;
  // Local estimate no longer reflects the last oversize API call.
  if (force) host.lastProviderInputTokens = 0;
  // The prompt prefix changed, so the measured anchor is stale: the next send
  // re-bills a different prompt. Drop it so the estimate rebuilds from the
  // post-compaction event log.
  host.contextAnchor = null;
  // compaction appends only what it synthesised (summary boundary + rescued
  // plan); the retained tail is already on disk and never re-appended. "New"
  // is decided by stable link id, not object reference, since `compact()`
  // rebuilds kept events ({...e}) — a reference check would duplicate the tail.
  const newEvents = host.newCompactionEvents(result.events);
  if (result.droppedRange) {
 // The original transcript stays on disk; some UIs
 // then tells the model where to re-read it. We do both: leave the
 // JSONL append-only, and write a Markdown archive the model can grep.
    const head = result.events[0];
    if (head?.type === "compaction") {
      // keepFrom points into the append-only file at the first retained turn:
      // the first event after the new prefix that is already persisted.
      const keepFrom = host.compactionKeepFrom(result.events);
      const archive = historyArchivePath(host.id);
      let pointer = "";
      try {
        const dropped = host.events.slice(result.droppedRange.from, result.droppedRange.to);
        await appendFile(
          archive,
          `\n## Compacted ${new Date().toISOString()}\n\n${renderTranscriptArchive(dropped)}`,
          "utf-8",
        );
        pointer =
          `\n\nFull text of the summarised turns: ${archive} (Markdown, oldest first). ` +
          `When you need something exact from before this summary — a design or plan you wrote, code, ` +
          `an error message, the user's literal words — grep that file for a keyword and read around ` +
          `the match instead of guessing or redoing the work.`;
      } catch {
 /* archive is best-effort; the JSONL still has the turns */
      }
      const restored = await host.restoreDroppedFiles(
        host.events.slice(result.droppedRange.from, result.droppedRange.to),
        result.events.slice(1),
        window,
      );
      const withBoundary = {
        ...head,
        keepFrom,
        summary: `${head.summary}${restored ? `\n\n${restored}` : ""}${pointer}`,
      };
      result.events[0] = withBoundary;
      newEvents[0] = withBoundary;
    }
  }
  host.events = result.events;
 // Append ONLY the events compaction genuinely created (the summary, and a
 // rescued plan if compact synthesised one). Never re-append the retained
 // tail — those turns are already in the file and stay there for resume /
 // export / grep; `liveTranscript` rebuilds the model view from `keepFrom`.
  for (const e of newEvents) {
    await host.persistEvent(e);
  }
 // Notify listeners of the new compaction event.
  const compactionEvent = host.events.find((e) => e.type === "compaction");
  if (compactionEvent) host.notify(compactionEvent);
  await host.rebuildSystemPrompt();
 // PostCompact hooks fire after the new state is committed.
  const summary = compactionEvent && compactionEvent.type === "compaction"
    ? compactionEvent.summary
    : "";
  await host.hooks.runPostCompact(hookTrigger, summary).catch(() => undefined);

  // Breaker evaluation on a successful compaction: if the live transcript is
  // still at/over the hard trigger, the compaction did not actually get us
  // under budget — real thrashing. Count it and trip the breaker at the
  // threshold. Otherwise the compaction worked: clear both streaks (and
  // re-enable auto when a manual /compact rescued the session).
  const after = estimateEventTokens(host.events, estimateTokens);
  if (after >= trigger) {
    host.compactNoopStreak++;
    const limit = host.config.autoCompactMaxConsecutiveFailures ?? DEFAULT_AUTOCOMPACT_MAX_FAILURES;
    if (host.compactNoopStreak >= limit) {
      host.tripAutoCompactBreaker(
        `thrashing: still over budget after compact (${after} ≥ ${trigger})`,
        { streak: host.compactNoopStreak, before: trigger, after },
      );
    }
  } else {
    host.compactFailStreak = 0;
    host.compactNoopStreak = 0;
    host.autoCompactDisabled = false;
  }
}

/** Public manual compaction (the `/compact` command). Forces a summary pass
 * now regardless of token pressure, keeping the session going on the same
 * task (unlike clearWorkingContext, which draws a task boundary). */
export async function sessionCompact(host: CompactHost, focus?: string): Promise<void> {
  await host.maybeCompact({ force: true, focus });
}

/**
 * Anchor (or unanchor) a prior message against compaction. A pinned message
 * is kept verbatim through folds/trims — use it for a key requirement the
 * user wants preserved across a long session. Append-only safe: the flag is
 * applied to the in-memory event AND a `pin` control event is persisted so
 * the anchor survives a resume (last pin per message id wins on reload).
 * Returns false when no message with that id exists.
 */
export async function pinMessage(
  host: CompactHost,
  messageId: string,
  pinned = true,
): Promise<boolean> {
  if (host.disposed) throw new Error("session disposed");
  let found = false;
  for (const e of host.events) {
    if (e.type === "message" && e.id === messageId) {
      e.pinned = pinned ? true : undefined;
      found = true;
    }
  }
  if (!found) return false;
  const ev: Event = { type: "pin", messageId, pinned };
  await host.persistEvent(ev).catch(() => undefined);
  host.notify(ev);
  return true;
}

/** Ids of currently pinned messages (anchored against compaction). */
export function pinnedMessageIds(host: CompactHost): string[] {
  const ids: string[] = [];
  for (const e of host.events) {
    if (e.type === "message" && e.pinned) ids.push(e.id);
  }
  return ids;
}

export async function clearWorkingContext(
  host: CompactHost,
  reason?: string,
): Promise<boolean> {
  const hasWork = host.events.some(
    (e) =>
      (e.type === "message" && e.role === "assistant") ||
      e.type === "tool_result",
  );
  if (!hasWork) return false;

  const modelWindow = lookupContextWindow(host.model);
  const window = host.config.contextWindow ?? modelWindow.contextWindow;
  const trigger = Math.max(4_000, Math.floor(window * FORCED_SHRINK_RATIO));
  const result = await host.runCompaction(trigger, true).catch(() => null);

  const summaryEvent =
    result?.events.find((e) => e.type === "compaction") ??
    host.events.find((e) => e.type === "compaction");
  const boundary: Event = {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "user",
    content: [
      {
        type: "text",
        text: TASK_BOUNDARY_MARKER + (reason ? `\n\nReason: ${reason}` : ""),
      },
    ],
  };
  const next: Event[] = summaryEvent ? [summaryEvent, boundary] : [boundary];

  host.events = next;
  host.lastProviderInputTokens = 0;
  host.contextAnchor = null;
  for (const e of next) {
    if (host.persisted.includes(e)) continue;
    await host.persistEvent(e).catch(() => undefined);
  }
  host.notify(boundary);
  await host.rebuildSystemPrompt().catch(() => undefined);
  await host.hooks.runSessionStart("clear").catch(() => undefined);
  return true;
}