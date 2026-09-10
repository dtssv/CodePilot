// Checkpoint writer — per-session long-term memory file.
//
// Why checkpoints?
// ----------------
// Compaction shrinks a session's in-memory transcript so the model can keep
// running. It does not, by itself, let a brand-new session resume the same
// work: the compacted summary is short and lossy. Checkpoints are the
// durable, cross-session companion: every time the session crosses a token
// threshold or completes a goal round, the writer distils the transcript
// into a 7-section markdown file under `.codepilot/checkpoints/<id>.md`.
//
// When a future session is started with the same id (or the user explicitly
// "resumes" by passing the same `sessionId` AND a checkpoint exists), we
// inject the checkpoint's summary into the system prompt instead of
// replaying the entire JSONL. Compaction still owns in-session memory
// pressure; checkpoints own cross-session continuity.
//
// File layout (7 sections, all required to exist, content may be "(none)"):
//   ## Active intent      - the user's most recent commitment-style request
//   ## Next action        - the single most useful next step
//   ## Task tree          - plan steps with status icons
//   ## Current work       - in-flight files, commands, results
//   ## Files touched      - paths the agent read/edited this checkpoint
//   ## Errors & fixes     - bugs and their resolutions
//   ## Decisions          - design choices that future sessions need
//
// The writer is a thin layer over the filesystem: no concurrency control
// beyond the in-process mutex, and the file is plain text so humans and
// tools can read it directly.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Event, PlanStep } from "./types.js";
import { estimateTokens } from "./tokens.js";
import type { ChatProvider } from "./providers/types.js";

/** Canonical section order — keep aligned with the markdown layout. */
export const CHECKPOINT_SECTIONS = [
  "Active intent",
  "Next action",
  "Task tree",
  "Current work",
  "Files touched",
  "Errors & fixes",
  "Decisions",
] as const;

export type CheckpointSection = (typeof CHECKPOINT_SECTIONS)[number];

/** Heuristics for the writer. All fields are optional; sane defaults apply. */
export interface CheckpointOptions {
  /** When the source session's estimated token total exceeds this, the
   *  writer is triggered. Default = compaction threshold. */
  tokenThreshold?: number;
  /** When the source session has accumulated at least this many new turns
   *  since the last checkpoint, the writer is triggered. Default 6. */
  turnsThreshold?: number;
  /** Maximum tokens the writer may produce. Default 1500. */
  maxSummaryTokens?: number;
  /** Provider used when the writer needs to ask a small model for a
   *  condensed summary. Optional — without it the writer falls back to a
   *  deterministic local extractor. */
  summariser?: ChatProvider;
  /** Model name for the small-model summariser. */
  summaryModel?: string;
}

export interface CheckpointTrigger {
  shouldCheckpoint: boolean;
  reason: string;
  estimatedTokens: number;
  turnsSinceLast: number;
}

/** Decide whether the current state calls for a checkpoint write. */
export function shouldCheckpoint(
  events: ReadonlyArray<Event>,
  lastCheckpointAt: number | null,
  opts: CheckpointOptions = {}
): CheckpointTrigger {
  const threshold = opts.tokenThreshold ?? 100_000;
  const turnsThreshold = opts.turnsThreshold ?? 6;
  const tokens = estimateEventTokens(events);
  // A "turn" = one user message + the assistant turn(s) that follows.
  const turns = countTurns(events);
  const turnsSinceLast = lastCheckpointAt == null
    ? turns
    : turns - countTurnsUpTo(events, lastCheckpointAt);
  if (tokens >= threshold) {
    return {
      shouldCheckpoint: true,
      reason: `tokens ${tokens} >= threshold ${threshold}`,
      estimatedTokens: tokens,
      turnsSinceLast,
    };
  }
  if (turnsSinceLast >= turnsThreshold) {
    return {
      shouldCheckpoint: true,
      reason: `${turnsSinceLast} new turns since last checkpoint (>= ${turnsThreshold})`,
      estimatedTokens: tokens,
      turnsSinceLast,
    };
  }
  return {
    shouldCheckpoint: false,
    reason: `tokens ${tokens} < threshold ${threshold} and ${turnsSinceLast} turns < ${turnsThreshold}`,
    estimatedTokens: tokens,
    turnsSinceLast,
  };
}

function estimateEventTokens(events: ReadonlyArray<Event>): number {
  let total = 0;
  for (const e of events) {
    total += estimateTokens(serializeEvent(e));
  }
  return total;
}

function serializeEvent(e: Event): string {
  switch (e.type) {
    case "message":
      return e.content
        .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
        .join("\n");
    case "message_delta":
      return e.delta.type === "text" ? e.delta.text : e.delta.partialJson;
    case "tool_call":
      return JSON.stringify(e.input ?? {});
    case "tool_result":
      return e.content;
    case "plan":
      return JSON.stringify(e.steps);
    case "usage":
      return JSON.stringify(e.usage);
    case "compaction":
      return e.summary;
    case "status":
      return e.status;
    case "error":
      return e.message;
    case "mode":
      return `mode:${e.mode}`;
    case "mode_request":
      return `mode_request:${e.mode}`;
  }
}

function countTurns(events: ReadonlyArray<Event>): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "message" && e.role === "user") n++;
  }
  return n;
}

function countTurnsUpTo(events: ReadonlyArray<Event>, idx: number): number {
  let n = 0;
  const upTo = Math.min(idx, events.length);
  for (let i = 0; i < upTo; i++) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "user") n++;
  }
  return n;
}

/** Structured snapshot of the writer's input. Exposed for tests. */
export interface CheckpointSnapshot {
  activeIntent: string;
  nextAction: string;
  taskTree: string;
  currentWork: string;
  filesTouched: string;
  errorsFixes: string;
  decisions: string;
}

/** Build a snapshot from a list of events using a deterministic local
 *  extractor (no LLM). The result is markdown-ready content for each
 *  section. */
export function buildCheckpointSnapshot(events: ReadonlyArray<Event>): CheckpointSnapshot {
  const lastUserText = findLastUserText(events);
  const lastAssistantText = findLastAssistantText(events);
  const plan = findLatestPlan(events);
  const taskTree = renderTaskTree(plan);
  const files = collectFilePaths(events);
  const errors = collectErrorFixes(events);
  const decisions = collectDecisions(events);
  const activeIntent = (lastUserText || "(no user request yet)").trim();
  const nextAction = inferNextAction(events, lastAssistantText);
  const currentWork = renderCurrentWork(events);
  return {
    activeIntent,
    nextAction,
    taskTree,
    currentWork,
    filesTouched: files,
    errorsFixes: errors,
    decisions,
  };
}

function findLastUserText(events: ReadonlyArray<Event>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "user") {
      const parts: string[] = [];
      for (const b of e.content) if (b.type === "text") parts.push(b.text);
      const joined = parts.join("\n").trim();
      if (joined) return joined;
    }
  }
  return "";
}

function findLastAssistantText(events: ReadonlyArray<Event>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") {
      const parts: string[] = [];
      for (const b of e.content) if (b.type === "text") parts.push(b.text);
      const joined = parts.join("\n").trim();
      if (joined) return joined;
    }
  }
  return "";
}

function findLatestPlan(events: ReadonlyArray<Event>): PlanStep[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "plan") return e.steps;
  }
  return undefined;
}

function renderTaskTree(plan: PlanStep[] | undefined): string {
  if (!plan || plan.length === 0) return "(none)";
  return plan
    .map((s) => {
      const icon =
        s.status === "completed" ? "✅" :
        s.status === "in_progress" ? "🔄" :
        s.status === "blocked" ? "🟡" : "🔵";
      return `${icon} ${s.id} — ${s.title}`;
    })
    .join("\n");
}

const FILE_PATH_RE = /\b(?:[A-Za-z0-9_./-]+\/)?[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b|\b[A-Za-z0-9_./-]{3,}\b/g;
const TOOL_FILE_HINTS = ["write_file", "edit_file", "read_file", "read_artifact", "bash", "write", "edit"];

function collectFilePaths(events: ReadonlyArray<Event>): string {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (const e of events) {
    if (e.type === "tool_call") {
      // Only extract paths when the tool is file-related.
      if (TOOL_FILE_HINTS.includes(e.name)) {
        const s = JSON.stringify(e.input ?? {});
        for (const m of s.match(FILE_PATH_RE) ?? []) {
          if (looksLikePath(m) && !seen.has(m)) {
            seen.add(m);
            recent.push(m);
          }
        }
      }
    } else if (e.type === "tool_result") {
      const matches = e.content.match(FILE_PATH_RE);
      if (matches) {
        for (const m of matches) {
          if (looksLikePath(m) && !seen.has(m)) {
            seen.add(m);
            recent.push(m);
          }
        }
      }
    }
  }
  if (recent.length === 0) return "(none)";
  // Keep at most 30 entries to avoid runaway lists.
  return recent.slice(-30).map((p) => `- \`${p}\``).join("\n");
}

function looksLikePath(s: string): boolean {
  if (!s) return false;
  // Reject bare words with no separator or extension.
  if (!/[/.]/.test(s)) return false;
  // Reject common english words that incidentally match the pattern.
  if (/^(?:the|and|for|with|that|this|from|have|into|your|their)$/i.test(s)) return false;
  return true;
}

function collectErrorFixes(events: ReadonlyArray<Event>): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "error") {
      const msg = e.message.trim().split("\n")[0]!.slice(0, 200);
      lines.push(`- ❌ ${msg}`);
    } else if (e.type === "tool_result" && e.isError) {
      const msg = e.content.trim().split("\n")[0]!.slice(0, 200);
      lines.push(`- ❌ ${msg}`);
    } else if (e.type === "message" && e.role === "assistant") {
      for (const b of e.content) {
        if (b.type === "text") {
          const m = b.text.match(/(?:fixed|resolved|root cause|修复|解决|错误)[^.\n]{0,160}/i);
          if (m) lines.push(`- ✅ ${m[0].trim().slice(0, 200)}`);
        }
      }
    }
  }
  if (lines.length === 0) return "(none)";
  // Dedup while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out.slice(-15).join("\n");
}

function collectDecisions(events: ReadonlyArray<Event>): string {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "message" || e.role !== "assistant") continue;
    for (const b of e.content) {
      if (b.type !== "text") continue;
      // Heuristic: pick out "decided to …" / "we will …" sentences.
      const re = /(?:decided to|we will|let'?s|chosen|chose|决定|采用|选择)[^.\n]{0,180}/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(b.text)) !== null) {
        out.push(`- ${m[0].trim().slice(0, 200)}`);
        if (out.length > 30) break;
      }
    }
  }
  if (out.length === 0) return "(none)";
  return out.slice(-15).join("\n");
}

function renderCurrentWork(events: ReadonlyArray<Event>): string {
  // Take the last ~6 user/assistant exchanges verbatim.
  const recent: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "message") continue;
    if (e.role !== "user" && e.role !== "assistant") continue;
    const text = e.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join(" ")
      .trim();
    if (!text) continue;
    const speaker = e.role === "user" ? "user" : "assistant";
    recent.push(`- **${speaker}**: ${text.slice(0, 240)}`);
    if (recent.length >= 6) break;
  }
  if (recent.length === 0) return "(none)";
  return recent.reverse().join("\n");
}

function inferNextAction(events: ReadonlyArray<Event>, lastAssistant: string): string {
  // Prefer the most recent "in_progress" plan step.
  const plan = findLatestPlan(events);
  if (plan) {
    const next = plan.find((s) => s.status === "in_progress") ??
      plan.find((s) => s.status === "pending");
    if (next) return `Resume plan step ${next.id} — ${next.title}`;
  }
  // Otherwise, look for an explicit "next:" or numbered step in the last
  // assistant message.
  const m = lastAssistant.match(/(?:next(?: step)?[:：])\s*([^\n]{1,200})/i);
  if (m) return m[1]!.trim();
  return "(none — derive from current plan)";
}

/** Render a snapshot to a markdown document. */
export function renderCheckpointMarkdown(snap: CheckpointSnapshot, header?: string): string {
  const stamp = header ?? `Checkpoint written at ${new Date().toISOString()}`;
  return [
    `# ${stamp}`,
    "",
    "_This file is written by the CodePilot checkpoint writer. Sections are stable; do not rename._",
    "",
    `## ${CHECKPOINT_SECTIONS[0]}`,
    "",
    snap.activeIntent || "(none)",
    "",
    `## ${CHECKPOINT_SECTIONS[1]}`,
    "",
    snap.nextAction || "(none)",
    "",
    `## ${CHECKPOINT_SECTIONS[2]}`,
    "",
    snap.taskTree || "(none)",
    "",
    `## ${CHECKPOINT_SECTIONS[3]}`,
    "",
    snap.currentWork || "(none)",
    "",
    `## ${CHECKPOINT_SECTIONS[4]}`,
    "",
    snap.filesTouched || "(none)",
    "",
    `## ${CHECKPOINT_SECTIONS[5]}`,
    "",
    snap.errorsFixes || "(none)",
    "",
    `## ${CHECKPOINT_SECTIONS[6]}`,
    "",
    snap.decisions || "(none)",
    "",
  ].join("\n");
}

/** Parse a checkpoint markdown back into a snapshot. Best-effort. */
export function parseCheckpointMarkdown(text: string): CheckpointSnapshot {
  const out: CheckpointSnapshot = {
    activeIntent: "",
    nextAction: "",
    taskTree: "",
    currentWork: "",
    filesTouched: "",
    errorsFixes: "",
    decisions: "",
  };
  const lines = text.split(/\r?\n/);
  let current: keyof CheckpointSnapshot | null = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = mapSectionToKey(h[1]!);
      continue;
    }
    if (current) {
      if (out[current]) out[current] += line + "\n";
      else out[current] = line + "\n";
    }
  }
  for (const k of Object.keys(out) as Array<keyof CheckpointSnapshot>) {
    out[k] = out[k].trim();
    if (!out[k]) out[k] = "(none)";
  }
  return out;
}

function mapSectionToKey(title: string): keyof CheckpointSnapshot | null {
  const t = title.trim().toLowerCase();
  if (t.includes("active intent")) return "activeIntent";
  if (t.includes("next action") || t.includes("next concrete")) return "nextAction";
  if (t.includes("task tree")) return "taskTree";
  if (t.includes("current work")) return "currentWork";
  if (t.includes("files")) return "filesTouched";
  if (t.includes("errors")) return "errorsFixes";
  if (t.includes("decisions")) return "decisions";
  return null;
}

// ---------------------------------------------------------------------------
// File-backed store.
// ---------------------------------------------------------------------------

/** Resolve the on-disk path for a session's checkpoint. */
export function checkpointPath(cwd: string, sessionId: string): string {
  return join(cwd, ".codepilot", "checkpoints", `${sessionId}.md`);
}

/** Read the persisted checkpoint text (or null if none). */
export async function readCheckpoint(cwd: string, sessionId: string): Promise<string | null> {
  try {
    return await readFile(checkpointPath(cwd, sessionId), "utf-8");
  } catch {
    return null;
  }
}

/** True if a checkpoint file exists for this session. */
export async function checkpointExists(cwd: string, sessionId: string): Promise<boolean> {
  try {
    await access(checkpointPath(cwd, sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Build a short summary suitable for system-prompt injection. */
export function summariseCheckpointForPrompt(text: string, maxChars = 1800): string {
  // The checkpoint file is already sectioned; we keep the first 1-2 lines
  // of each section and strip the rest. Cheap and stable.
  const sections = text.split(/^##\s+/m);
  const head = sections[0]?.split("\n").slice(0, 2).join("\n") ?? "";
  const out: string[] = [`[Earlier-session checkpoint]\n${head.trim()}`];
  for (const sec of sections.slice(1)) {
    const newline = sec.indexOf("\n");
    if (newline < 0) continue;
    const title = sec.slice(0, newline).trim();
    const body = sec.slice(newline + 1).trim();
    const head2 = body.split(/\r?\n/).slice(0, 4).join("\n");
    out.push(`## ${title}\n${head2}`);
  }
  const joined = out.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, maxChars) + `\n\n[...truncated ${joined.length - maxChars} chars]`;
}

export interface WriteCheckpointResult {
  path: string;
  bytes: number;
  usedModel: boolean;
}

/** Write a fresh checkpoint. Overwrites the file in place. */
export async function writeCheckpoint(
  cwd: string,
  sessionId: string,
  events: ReadonlyArray<Event>,
  opts: CheckpointOptions = {}
): Promise<WriteCheckpointResult> {
  const snap = buildCheckpointSnapshot(events);
  let usedModel = false;
  let content = renderCheckpointMarkdown(snap, `Checkpoint for ${sessionId}`);
  if (opts.summariser) {
    try {
      const condensed = await callSummariser(opts.summariser, snap, opts.summaryModel, opts.maxSummaryTokens ?? 1500);
      if (condensed.trim()) {
        usedModel = true;
        content = condensed.trim() + "\n\n" + renderCheckpointMarkdown(snap, `Checkpoint for ${sessionId}`);
      }
    } catch {
      // fall through with the deterministic snapshot
    }
  }
  const path = checkpointPath(cwd, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return { path, bytes: Buffer.byteLength(content, "utf-8"), usedModel };
}

/** Append a round-level delta to an existing checkpoint (used by goal loop). */
export async function appendCheckpointRound(
  cwd: string,
  sessionId: string,
  round: number,
  status: "running" | "completed" | "blocked" | "round_limit",
  reason: string | undefined,
  blockedReason: string | undefined
): Promise<void> {
  const path = checkpointPath(cwd, sessionId);
  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    /* fresh */
  }
  const block = [
    "",
    `### Round ${round} — ${status} @ ${new Date().toISOString()}`,
    reason ? `**Reason:** ${reason}` : "",
    blockedReason ? `**Blocked reason:** ${blockedReason}` : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, existing + block, "utf-8");
}

async function callSummariser(
  provider: ChatProvider,
  snap: CheckpointSnapshot,
  model: string | undefined,
  maxTokens: number
): Promise<string> {
  const input = JSON.stringify(snap, null, 2);
  const sys = `You are a checkpoint writer. The user will give you a structured snapshot from a coding session. Produce a tight 7-section markdown file matching exactly these headings, in this order, with each section <= ${Math.floor(maxTokens / 7)} tokens:

## Active intent
## Next action
## Task tree
## Current work
## Files touched
## Errors & fixes
## Decisions

Preserve verbatim any path / command / error message. No preamble.`;
  const collected: string[] = [];
  for await (const ev of provider.stream({
    model: model ?? provider.smallModel,
    messages: [{ role: "user", content: [{ type: "text", text: input }] }],
    systemPrompt: sys,
    maxTokens,
  })) {
    if (ev.kind === "text_delta") collected.push(ev.text);
    if (ev.kind === "error") throw new Error(ev.message);
  }
  return collected.join("");
}

// ---------------------------------------------------------------------------
// In-memory hook to be called by the agent loop / goal loop. Pure data — the
// caller decides when to persist.
// ---------------------------------------------------------------------------

export interface CheckpointHook {
  /** True after a checkpoint has been written for the given session. */
  hasCheckpoint: boolean;
  /** Index in `events` of the last checkpoint boundary. */
  lastCheckpointAt: number | null;
  /** Compute whether a checkpoint should be written now. */
  check(events: ReadonlyArray<Event>, opts?: CheckpointOptions): CheckpointTrigger;
}

export function makeCheckpointHook(
  cwd: string,
  sessionId: string
): CheckpointHook {
  return {
    hasCheckpoint: false,
    lastCheckpointAt: null,
    check(events, opts) {
      const t = shouldCheckpoint(events, this.lastCheckpointAt, opts);
      return t;
    },
  };
}

/** Internal: unique run id for logging. */
export const _RUN_ID = (): string => randomUUID().slice(0, 8);
