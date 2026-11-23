// JSONL load/persist and system-prompt rebuild. Extracted from Session (move-only split).

import { appendFile, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import {
  decideLazyMcp,
  listAdvertisedToolNames,
  rememberAdvertisedToolNames,
} from "../agent/agent-messages.js";
import { resolveDeferredWire } from "../tools/wirePolicy.js";
import { loadAutoMemoryPromptStub, type AutoMemoryConfig } from "../memory/autoMemory.js";
import { readMemory, readProjectInstructions, summariseMemory } from "../memory/memory.js";
import {
  buildSandboxUnavailable,
  formatSandboxPromptNote,
  type ResolvedSandbox,
} from "../sandbox/sandbox.js";
import {
  buildSystemPrompt,
  refreshVolatileSystemPrompt,
  type OutputStyle,
} from "../systemPrompt/index.js";
import { renderCustomAgentsBlock, type CustomAgent } from "../skills/customAgents.js";
import type { Skill } from "../skills/skills.js";
import type { McpManager } from "../mcp/mcp.js";
import { extractPlan, liveTranscript } from "../compaction/compaction.js";
import type { AgentMode, CodepilotConfig, Event, ImageAttachment } from "../types.js";
import { applyProviderAndModel } from "../config/providerCatalog.js";
import { PermissionEngine } from "../permissions/permissions.js";
import { ArtifactStore } from "../tools/artifacts.js";
import type { ToolRegistry } from "../tools/types.js";
import { projectStatePath, scratchDir } from "../workspace/projectState.js";
import { CORE_VERSION, linkIdForEvent, readGitBranch, stampEventMeta } from "../telemetry/eventMeta.js";
import { thawSession, readColdSessionText } from "./sessionCompression.js";
import {
  SESSIONS_DIR,
  deriveTitleFromText,
  firstTitleWorthyUserText,
  isWeakTitleSource,
  loadTitleFromDisk,
  sessionPath,
  titleSidecarPath,
} from "./session-utils.js";
import { eventHasOffloadedImages } from "./session-helpers.js";
import type { BoundedSinkQueue } from "./sessionSink.js";
import {
  readCheckpoint,
  summariseCheckpointForPrompt,
} from "./checkpoints.js";

type SystemPromptCache = {
  staticPrefix: string;
  dynamicSuffix: string;
  full: string;
  stableContext?: string;
  volatileSuffix?: string;
} | null;

/** Threshold above which an inline image is offloaded to an artifact. */
const IMAGE_OFFLOAD_BYTES = 8 * 1024;

export type PersistHost = {
  id: string;
  cwd: string;
  readOnly: boolean;
  config: CodepilotConfig;
  model: string;
  activeProviderId: string | undefined;
  mode: AgentMode;
  events: Event[];
  persisted: Event[];
  lastPersistedLinkId: string | undefined;
  gitBranchCache: string | undefined;
  turnCounter: number;
  title: string | null;
  tornTailRepairs: number;
  toolRegistry: ToolRegistry;
  /** Session-monotonic wire tool names (prompt-cache stability). */
  advertisedToolNames: Set<string>;
  artifacts: ArtifactStore;
  sandbox: ResolvedSandbox;
  permissions: PermissionEngine;
  deliveryRoots: string[];
  systemPromptExtra: string | undefined;
  discoveredSkills: Skill[];
  customAgents: Map<string, CustomAgent>;
  hostSurface: "cli" | "tui" | "vscode" | "idea";
  outputStyle: OutputStyle;
  resumedFromInterrupt: boolean;
  _sandboxUnavailable: boolean;
  /** Live MCP manager (null when none / still starting). */
  mcp: McpManager | null;
  systemPromptCache: SystemPromptCache;
  /** Last provider-reported input tokens (context gauge / compaction anchor). */
  lastProviderInputTokens: number;
  contextAnchor: { input: number; eventCount: number } | null;
  foldedToolResultStubs: Map<string, string>;
  eventSink: BoundedSinkQueue | undefined;
  notify(e: Event): void;
  rebuildUndoStacks(): void;
};

/**
 * Fold persisted `pin` control events onto their target messages. Latest
 * pin per message id wins (so a later unpin overrides an earlier pin). Runs
 * on load and is cheap (one pass; sessions rarely have many pins).
 */
function applyPersistedPins(events: Event[]): void {
  const latest = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "pin") latest.set(e.messageId, e.pinned);
  }
  if (latest.size === 0) return;
  for (const e of events) {
    if (e.type === "message" && latest.has(e.id)) {
      e.pinned = latest.get(e.id) ? true : undefined;
    }
  }
}

/**
 * Repair a torn JSONL tail left by a crash mid-append. `text` is the full
 * file contents already read by loadFromDisk. If the file is non-empty and its
 * final line is a torn (incomplete) JSON fragment — the file does NOT end in a
 * newline AND that trailing fragment does not parse as JSON — truncate the
 * file back to the last complete newline boundary. This keeps the log
 * self-consistent and, critically, prevents the next append from concatenating
 * a new line onto the fragment (appendFile does not insert a separator). A
 * file that already ends in a newline, is empty, or whose trailing fragment
 * happens to be valid JSON is left untouched. Best-effort and write-open only.
 */
async function repairTornTail(host: PersistHost, path: string, text: string): Promise<void> {
  if (text.length === 0) return;
  // A trailing newline means the last record was fully flushed — nothing torn.
  if (text.endsWith("\n")) return;
  const lastNl = text.lastIndexOf("\n");
  // The bytes after the final newline (or the whole file, if there is none)
  // are the un-terminated trailing fragment.
  const tail = text.slice(lastNl + 1);
  if (tail.trim().length === 0) return;
  try {
    JSON.parse(tail);
    // The fragment is valid JSON that merely lacks a trailing newline. Don't
    // drop a good record — restore the missing separator so the next append
    // starts on its own line.
    await appendFile(path, "\n", "utf-8");
    return;
  } catch {
    /* genuinely torn — fall through to truncate */
  }
  // Truncate to the last complete record. lastNl < 0 means the file is a
  // single torn line with no prior complete record → truncate to empty.
  const keep = lastNl >= 0 ? lastNl + 1 : 0;
  await truncate(path, keep);
  host.tornTailRepairs += 1;
}

/** Return a disk-serialisable copy of `e` with large `images[].base64`
 * replaced by `{ mediaType, ref }`, plus the list of offloads performed (ref
 * + original byte size) so the caller can record content_replacement audit
 * events. Small images stay inline. Non-image events pass through unchanged
 * (by reference — no copy cost) with an empty offload list. */
async function offloadEventImages(
  host: PersistHost,
  e: Event,
): Promise<{ event: Event; offloads: Array<{ ref: string; bytes: number }> }> {
  const imgs = (e as { images?: ImageAttachment[] }).images;
  if (!Array.isArray(imgs) || imgs.length === 0) return { event: e, offloads: [] };
  let changed = false;
  const offloads: Array<{ ref: string; bytes: number }> = [];
  const mapped = await Promise.all(
    imgs.map(async (img) => {
      if (!img.base64 || img.base64.length < IMAGE_OFFLOAD_BYTES) return img;
      try {
        const bytes = Buffer.byteLength(img.base64, "utf-8");
        const ref = await host.artifacts.write(img.base64, `image/${img.mediaType}`);
        changed = true;
        offloads.push({ ref, bytes });
        return { mediaType: img.mediaType, ref } as unknown as ImageAttachment;
      } catch {
        return img; // best-effort: keep inline if the store write fails
      }
    }),
  );
  if (!changed) return { event: e, offloads: [] };
  return { event: { ...e, images: mapped } as Event, offloads };
}

/** Rehydrate any offloaded `{ mediaType, ref }` images back to base64 after
 * loading from disk, so the in-memory transcript is complete. Best-effort:
 * a missing artifact leaves a placeholder note rather than crashing resume. */
async function rehydrateEventImages(host: PersistHost, e: Event): Promise<Event> {
  const imgs = (e as { images?: Array<{ mediaType: string; base64?: string; ref?: string }> }).images;
  if (!Array.isArray(imgs) || imgs.length === 0) return e;
  let changed = false;
  const mapped = await Promise.all(
    imgs.map(async (img) => {
      if (img.base64 || !img.ref) return img;
      try {
        const base64 = await host.artifacts.read(img.ref);
        changed = true;
        return { mediaType: img.mediaType, base64 };
      } catch {
        changed = true;
        return { mediaType: img.mediaType, base64: "" }; // artifact gone
      }
    }),
  );
  if (!changed) return e;
  return { ...e, images: mapped } as Event;
}

/** Append a `content_replacement` audit record for each payload moved to the
 * artifact store while persisting `e`: the images just offloaded (passed in),
 * plus a tool_result that already carries an `artifactRef` from an upstream
 * spill. Best-effort — a failed audit never blocks the canonical write. */
async function recordContentReplacements(
  host: PersistHost,
  e: Event,
  imageOffloads: Array<{ ref: string; bytes: number }>,
): Promise<void> {
  const records: Array<Extract<Event, { type: "content_replacement" }>> = [];
  for (const off of imageOffloads) {
    records.push({
      type: "content_replacement",
      ownerId: (e as { id?: string }).id ?? host.id,
      target: "image",
      artifactRef: off.ref,
      bytes: off.bytes,
    });
  }
  if (e.type === "tool_result" && e.artifactRef) {
    // The full payload's authoritative size is the stored artifact's size;
    // the inline content is only the head+tail stub.
    const bytes =
      (await host.artifacts.size(e.artifactRef)) ??
      Buffer.byteLength(e.content, "utf-8");
    records.push({
      type: "content_replacement",
      ownerId: e.toolCallId,
      target: "tool_result",
      artifactRef: e.artifactRef,
      bytes,
      tool: e.name,
    });
  }
  for (const rec of records) {
    host.events.push(rec);
    // persistEvent again — but the content_replacement short-circuits the
    // recursion guard above, so this just appends the audit line.
    await sessionPersistEvent(host, rec).catch(() => undefined);
    // Notify subscribers so a live UI can render it quietly. Non-model, not a
    // transcript row — clients surface it as an advisory (like micro-fold).
    host.notify(rec);
  }
}

export async function sessionLoadFromDisk(host: PersistHost): Promise<void> {
  try {
    const path = sessionPath(host.id);
    // Cold-storage: a session compressed by housekeeping has only a `.jsonl.br`.
    // A write-open session is thawed back to plaintext first (it is about to
    // append); a read-only open reads the compressed text directly without
    // materializing the plaintext. Both are no-ops for a normal live session.
    let text: string;
    if (!host.readOnly) {
      await thawSession(host.id).catch(() => undefined);
      text = await readFile(path, "utf-8");
    } else {
      try {
        text = await readFile(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const cold = await readColdSessionText(host.id);
        if (cold === null) throw err;
        text = cold;
      }
    }
    // Physical integrity: if the process crashed mid-append, the final line
    // can be a torn (incomplete) JSON fragment with no trailing newline. We
    // skip it when parsing (below), but a torn tail also poisons the NEXT
    // Repair a torn tail on write-open: truncate to the last complete `\n`
    // boundary so appendFile doesn't concatenate onto a partial line.
    if (!host.readOnly) {
      await repairTornTail(host, path, text).catch(() => undefined);
    }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Parse synchronously and only `await` the image rehydration for the few
    // events that actually carry offloaded images. Awaiting every event (most
    // have none) forced one microtask round-trip per line — on multi-hundred-
    // line sessions that dominated resume latency for no work.
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Event;
        if (eventHasOffloadedImages(parsed)) {
          // Rehydrate offloaded images (base64 stored as an artifact ref) so
          // the in-memory transcript is complete.
          host.persisted.push(await rehydrateEventImages(host, parsed));
        } else {
          host.persisted.push(parsed);
        }
      } catch {
 /* skip malformed */
      }
    }
    host.events = liveTranscript(host.persisted);
    // Reapply compaction anchors: the latest `pin` per message id wins
    // (append-only safe — the original message line is never rewritten).
    applyPersistedPins(host.events);
    // Rebuild undo/redo stacks so `/undo` survives a reload.
    host.rebuildUndoStacks();
    for (let i = host.persisted.length - 1; i >= 0; i--) {
      const link = linkIdForEvent(host.persisted[i]!);
      if (link) {
        host.lastPersistedLinkId = link;
        break;
      }
    }
    // Seed the turn counter from the highest claim turn already recorded (or
    // the user-message count as a fallback), so a resumed run's claim does not
    // restart numbering at 1.
    let maxTurn = 0;
    let userMessages = 0;
    for (const e of host.persisted) {
      if (e.type === "status" && e.claim) maxTurn = Math.max(maxTurn, e.claim.turn);
      else if (e.type === "message" && e.role === "user") userMessages += 1;
    }
    host.turnCounter = Math.max(maxTurn, userMessages);
    // Restore the last chosen model/provider from JSONL `type:"model"` events;
    // without it resume keeps the process default and a wrong model busts the
    // prompt-cache prefix.
    rehydrateModelFromPersisted(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
 // Hydrate title from sidecar; if missing or a weak nudge ("继续"), recover
 // from the first real user prompt so resume does not retitle the session.
  const t = await loadTitleFromDisk(host.id);
  if (t && !isWeakTitleSource(t)) {
    host.title = t;
  } else {
    const first = firstTitleWorthyUserText(host.persisted);
    if (first) {
      const derived = deriveTitleFromText(first);
      if (derived && derived !== "(untitled)") {
        host.title = derived;
        await writeFile(titleSidecarPath(host.id), derived, "utf-8").catch(() => undefined);
      }
    }
  }
}

/** Apply the latest `{ type: "model" }` event onto the in-memory session. */
export function rehydrateModelFromPersisted(host: PersistHost): void {
  let last: Extract<Event, { type: "model" }> | undefined;
  for (const e of host.persisted) {
    if (e.type === "model") last = e;
  }
  if (!last?.model) return;
  const prevModel = host.model;
  const prevProvider = host.activeProviderId;
  const applied = applyProviderAndModel(
    host.config,
    last.providerId,
    last.model,
  );
  host.config = applied.config;
  host.model = applied.model;
  host.activeProviderId = applied.providerId;
  // Same as setEndpoint: a restored model re-bills the prompt under its own
  // tokeniser / window, so prior measurements must not anchor the gauge.
  if (applied.model !== prevModel || applied.providerId !== prevProvider) {
    host.lastProviderInputTokens = 0;
    host.contextAnchor = null;
    host.foldedToolResultStubs.clear();
  }
}

export async function sessionPersistEvent(host: PersistHost, e: Event): Promise<void> {
  // Read-only open: never touch the JSONL. The in-memory transcript is still
  // maintained by callers (they push to this.events); only the durable write
  // is suppressed, since this process does not hold the write lease.
  if (host.readOnly) return;
  // Refresh branch occasionally (cheap spawn); keep last known value on miss.
  if (host.persisted.length % 25 === 0) {
    host.gitBranchCache = readGitBranch(host.cwd) ?? host.gitBranchCache;
  }
  const stamped = stampEventMeta(e, {
    cwd: host.cwd,
    gitBranch: host.gitBranchCache,
    parentId: host.lastPersistedLinkId,
    version: CORE_VERSION,
  });
  const link = linkIdForEvent(stamped);
  if (link) host.lastPersistedLinkId = link;
  host.persisted.push(stamped);
  const path = sessionPath(host.id);
  await mkdir(SESSIONS_DIR, { recursive: true });
  // Offload large inline image base64 to the content-addressed artifact store
  // before writing the JSONL line. Identical images dedup by hash, and a
  // 5 MB screenshot no longer bloats the session log (or gets re-read on every
  // resume). The in-memory `stamped`/`this.persisted` copies keep their base64;
  // only the on-disk line is slimmed. Rehydrated in `loadFromDisk`.
  const { event: forDisk, offloads } = await offloadEventImages(host, stamped);
  const line = JSON.stringify(forDisk);
  await appendFile(path, line + "\n", "utf-8");
  // Additive mirror: hand the exact JSONL line to an optional external sink
  // AFTER the canonical append resolves. Enqueue is synchronous, bounded, and
  // fail-soft — it never blocks or fails this write (JSONL is the source of
  // truth). No-op when no plugin/host registered a sink.
  host.eventSink?.enqueue(host.id, line);
  // Record every large-payload offload as a durable content_replacement so a
  // fork can replicate it and artifact GC / audit can walk referenced refs
  // from the JSONL. Covers both image offload (just done above) and a
  // tool_result whose large content was spilled upstream (it arrives here
  // already carrying an artifactRef). These records never go to the model and
  // are rendered quietly. Skipped while persisting a content_replacement
  // itself, so there is no recursion.
  if (stamped.type !== "content_replacement") {
    await recordContentReplacements(host, stamped, offloads);
  }
}

/** Scope for {@link sessionRebuildSystemPrompt}.
 * - `full` — rebuild staticPrefix + stableContext + volatile (model/tools/
 *   memory/skills/git snapshot). Busts the cached system prefix when those
 *   inputs change.
 * - `volatile` — reuse cached static+stable; refresh only the trailing tail
 *   (permission / sandbox notes / delivery / plan / mode guidance). Prefer
 *   this for mid-session grants and end-of-turn refreshes so a git checkout
 *   or memory re-read cannot rewrite the prompt-cache prefix. */
export type SystemPromptRebuildScope = "full" | "volatile";

export async function sessionRebuildSystemPrompt(
  host: PersistHost,
  opts: { scope?: SystemPromptRebuildScope } = {},
): Promise<void> {
  const scope = opts.scope ?? "full";
  const prev = host.systemPromptCache;
  if (
    scope === "volatile" &&
    prev?.staticPrefix &&
    prev.stableContext
  ) {
    host.systemPromptCache = await refreshVolatileSystemPrompt(
      { staticPrefix: prev.staticPrefix, stableContext: prev.stableContext },
      {
        cwd: host.cwd,
        sessionId: host.id,
        hostSurface: host.hostSurface,
        memory: {},
        plan: extractPlan(host.events),
        toolNames: [],
        deliveryRoots: host.deliveryRoots,
        sessionNotes: await buildSessionNotes(host),
        mcpInstructions: host.mcp?.listAllInstructions() ?? [],
        model: host.model,
        provider: host.config.provider ?? "anthropic",
        mode: host.mode,
        permissionMode: host.permissions.getMode(),
        outputStyle: host.outputStyle,
      },
    );
    return;
  }

  const memory = summariseMemory(await readMemory(host.cwd));
 // Workspace instruction files are the repo's rules: injected verbatim
 // (byte-capped), unlike the agent-written MEMORY.md notes in memory.project,
 // which only advertise their headings.
  const instructions = await readProjectInstructions(host.cwd, {
    walkToHome: host.config.memory?.walkToHome === true,
    maxBytes: host.config.memory?.instructionsMaxBytes,
  });
  if (instructions) memory.instructions = instructions;
 // Progressive memory: prompt gets a fixed-size stub (dir + counts), not the
 // growing MEMORY.md bullet wall. Full index stays on disk; relevant topic
 // bodies arrive via query-time recall / read_file.
  const autoCfg: AutoMemoryConfig = { enabled: host.config.autoMemoryEnabled !== false };
  const autoStub = await loadAutoMemoryPromptStub(host.cwd, autoCfg);
  if (autoStub) {
    memory.progressive = autoStub;
  }
  const plan = extractPlan(host.events);
 // The system prompt advertises exactly the tool set the provider request
 // will carry this turn — the same filter chain (mode → lazy MCP → lazy plugin
 // → toolExposure) as buildProviderToolDefs — so the model never expects a tool
 // the request omits, and under lazy discovery it sees the `mcp` / `tool_catalog`
 // meta-tool rather than the individual schemas.
  const mcpCount = host.toolRegistry.all().filter((t) => t.source === "mcp").length;
  const lazyMcp = decideLazyMcp(
    mcpCount,
    host.config.mcpToolDiscovery,
    host.config.mcpLazyThreshold,
  );
  const pluginCount = host.toolRegistry.all().filter((t) => t.source === "plugin").length;
  const lazyPlugin = decideLazyMcp(
    pluginCount,
    host.config.pluginToolDiscovery ?? "eager",
    host.config.pluginLazyThreshold,
  );
  const toolNames = listAdvertisedToolNames(host.toolRegistry, host.mode, {
    lazyMcp,
    lazyPlugin,
    model: host.model,
    toolExposure: host.config.toolExposure,
    previouslyAdvertised: host.advertisedToolNames,
    deferredWire: resolveDeferredWire(host.config),
  });
  rememberAdvertisedToolNames(host.advertisedToolNames, toolNames);
  const sessionNotes = await buildSessionNotes(host);
  host.systemPromptCache = await buildSystemPrompt({
    cwd: host.cwd,
    sessionId: host.id,
    hostSurface: host.hostSurface,
    memory,
    plan,
    toolNames,
    skills: host.discoveredSkills,
    mcpInstructions: host.mcp?.listAllInstructions() ?? [],
    scratchDir: scratchDir(host.cwd, host.id),
    projectStateDir: projectStatePath(host.cwd),
    deliveryRoots: host.deliveryRoots,
    extra: host.systemPromptExtra ?? "",
    sessionNotes,
    model: host.model,
    provider: host.config.provider ?? "anthropic",
    mode: host.mode,
    permissionMode: host.permissions.getMode(),
    outputStyle: host.outputStyle,
  });
}

/** Sandbox / resume / custom-agent notes for the volatile `<session_notes>` tail. */
async function buildSessionNotes(host: PersistHost): Promise<string> {
  // Sandbox posture: lean mode/network + extras (while granted) → sessionNotes.
  // Permission + delivery_roots ride `<runtime>` so mid-session grants / mode
  // flips only rewrite the volatile tail, not the cached stableContext.
  const sb = host.sandbox;
  const sandboxNote =
    sb.mode === "off"
      ? `Sandbox: mode=off (no OS confinement).`
      : formatSandboxPromptNote({
          mode: sb.mode,
          network: sb.network,
          extraWritablePaths: sb.writablePaths,
          unavailableHint: host._sandboxUnavailable
            ? buildSandboxUnavailable().hint
            : undefined,
        });
  const customAgentsBlock = renderCustomAgentsBlock(host.customAgents);
  const checkpoint = await readCheckpoint(host.cwd, host.id);
  let resumeNote = checkpoint
    ? `\n\n${summariseCheckpointForPrompt(checkpoint)}`
    : "";
  // One-shot recovery only for a true crash/restart (stale running status).
  // A normal text-only turn end is not an interrupt — do not inject this.
  if (host.resumedFromInterrupt) {
    resumeNote +=
      `\n\n<interrupted_run>\n` +
      `The previous run in this session was cut off by a crash or server restart ` +
      `(not a normal end-of-turn, and not a user cancel). Treat the user's next ` +
      `message as continuing the same conversation:\n` +
      `- Read the plan and the checkpoint above to see which steps are already ` +
      `done — do NOT repeat completed work.\n` +
      `- Resume at the first unfinished step and stay inside the original task.\n` +
      `- If the prior state is unclear, briefly say what you think is done and ` +
      `ask before redoing it.\n` +
      `</interrupted_run>`;
  }
  // Project bootstrap stays in cached `extra`. Sandbox / resume / custom
  // agents are session-variant → `sessionNotes` (volatile).
  return [
    customAgentsBlock,
    resumeNote.trim(),
    sandboxNote,
  ]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");
}