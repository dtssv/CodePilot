// Doom-loop detection: when the agent calls the same tool
// with the same input repeatedly without making progress, we surface a
// warning and (after a threshold) inject a steering message telling the
// model it's stuck.
//
// Three layers of detection:
//
// 1. Per-signature counting (exact (tool, input) repetition):
// - On the 3rd identical call we inject a tool-result warning.
// - On the 4th identical call we refuse the tool call entirely.
//
// 2. Sequence-level detection (the rotating-loop case): we keep a sliding
// window of recent call signatures and detect when the model re-issues
// a whole batch of calls it already made.
//
// 3. Path-level detection for `read_file`: re-reading the same path with
// an OVERLAPPING `startLine`/`maxLines` window (the fold-induced spiral,
// where the model thinks folded content is "gone" and re-fetches ground
// it already read) counts toward a soft path budget and WARNS. A
// non-overlapping, advancing window (legitimate paging through a large
// file: lines 1-500, 500-1000, 1000-1500 …) is progress — it resets the
// budget and is never penalised. This layer never refuses: every mainstream
// harness either dedups re-reads (Claude Code) or asks, but none hard-denies
// a read on path count — doing so false-positives on paging. Path-keyed
// result replay still serves a second windowed read of an already-fetched
// file from cache instead of another disk hit.
//
// DELIBERATELY REMOVED — "mutation burst": a former layer that warned then
// refused after N consecutive edits to the same path(s) without an intervening
// verify (test/build/lint) command. It was dropped on purpose and should not be
// re-added: no mainstream harness (opencode, codex, Claude Code) does this; it
// contradicted layer 3's own rule that a count must never hard-deny (legitimate
// iteration — building a large file section by section — is indistinguishable
// from a loop by edit count alone); and even as a warning it poisoned context,
// since weaker models tend to believe the "you're looping" message and abandon
// productive work. Exact-repetition (layer 1) and rotating batches (layer 2)
// still catch genuine no-progress loops without this false-positive-prone brake.

/** Signature of a single tool call: tool name + stable input hash. */
function signature(toolName: string, input: unknown): string {
 // Stable serialization: sort object keys so {a:1,b:2} === {b:2,a:1}.
  const stable = canonicalize(input);
  return `${toolName}::${stable}`;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

/** Normalize a filesystem path for path-level dedup (slash style, no ./). */
function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

/**
 * Path-scoped key for tools that re-target the same resource with varying
 * window args. Returns null when the tool/input has no path aggregation.
 */
export function pathKey(toolName: string, input: unknown): string | null {
  if (toolName !== "read_file") return null;
  if (!input || typeof input !== "object") return null;
  const path = (input as Record<string, unknown>).path;
  if (typeof path !== "string" || path.trim() === "") return null;
  return `read_file::path:${normalizePathKey(path)}`;
}

/** The 1-based inclusive line window a `read_file` input requests, or null for
 * a whole-file read (which we treat as covering everything). `startLine` is
 * 0-based in the tool input; `maxLines` bounds the count. */
export function readWindow(input: unknown): { from: number; to: number } | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const startLine = typeof obj.startLine === "number" ? obj.startLine : 0;
  const maxLines = typeof obj.maxLines === "number" ? obj.maxLines : undefined;
  // Whole-file read: covers everything. Use a sentinel upper bound.
  if (startLine === 0 && maxLines === undefined) return { from: 1, to: Number.MAX_SAFE_INTEGER };
  const from = startLine + 1;
  const to = maxLines === undefined ? Number.MAX_SAFE_INTEGER : startLine + maxLines;
  return { from, to: Math.max(from, to) };
}

/** Fraction of the requested window `req` already covered by `prior`. 1 = fully
 * re-reading ground already read (a spiral); 0 = a fresh, non-overlapping
 * region (progress). A whole-file read overlapping a whole-file read = 1. */
export function windowOverlapFraction(
  req: { from: number; to: number },
  prior: { from: number; to: number },
): number {
  const lo = Math.max(req.from, prior.from);
  const hi = Math.min(req.to, prior.to);
  const inter = Math.max(0, hi - lo + 1);
  // Cap req length to a sane finite value so a MAX_SAFE_INTEGER window divides.
  const reqLen = Math.max(1, Math.min(req.to, req.from + 1_000_000) - req.from + 1);
  return Math.min(1, inter / reqLen);
}

/** A windowed read counts toward the path spiral budget only when it overlaps
 * an already-read region by at least this fraction. Below it the read is
 * advancing through the file (legitimate paging) and resets the budget. */
export const PATH_OVERLAP_THRESHOLD = 0.6;

/**
 * Normalize a question to its semantic core: lowercased, with digits,
 * punctuation, whitespace and the trailing "data dump" stripped. Reworded /
 * re-id'd / data-appended repeats collapse toward the same string. Option
 * labels are excluded (models shuffle them between asks).
 */
export function questionFingerprints(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return [];
  const out: string[] = [];
  for (const q of qs) {
    const text = q && typeof q === "object" ? (q as { question?: unknown }).question : undefined;
    if (typeof text !== "string") continue;
    const norm = text
      .toLowerCase()
 // Drop everything after the first blank line — models append
 // "current data:\n• …" blocks that change between asks.
      .split(/\n\s*\n/)[0]!
      .replace(/[\d.,%·•:：()（）\[\]{}"'`，。、？?！!\-—\s]+/g, "")
      .trim();
    if (norm.length >= 4) out.push(norm);
  }
  return out;
}

/** Character-bigram Jaccard similarity of two normalized questions. Catches
 * reworded repeats ("选择谁" vs "你选择谁") that exact-equality misses, while
 * staying near 0 for genuinely different questions. */
export function questionSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string): Set<string> => {
    const g = new Set<string>();
    if (s.length === 1) { g.add(s); return g; }
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** Two questions are "the same" (for re-ask detection) at this threshold. */
export const QUESTION_SIMILARITY_THRESHOLD = 0.7;

/** Header line read_file prepends to its body, e.g. "(585 lines, 23249 bytes;
 * showing lines 2-151)". We parse it to recover the 1-based window the body
 * represents so a cached full read can be re-sliced for a narrower request. */
const READ_FILE_HEADER = /^\((\d+) lines, \d+ bytes(?:; showing lines (\d+)-(\d+))?\)/;

/** Re-slice a cached read_file body to the requested window. The cached
 * content is the verbatim tool result (header + numbered lines); when the
 * caller asks for lines [startLine, startLine+maxLines) and the cache holds
 * the full file, we return just those numbered lines with an adjusted
 * header. If anything doesn't parse, fall back to the full cached body —
 * over-serving is safe, under-serving re-triggers the re-read loop. */
function sliceWindow(cached: string, input: unknown): string {
  if (!input || typeof input !== "object") return cached;
  const obj = input as Record<string, unknown>;
  const startLine = typeof obj.startLine === "number" ? obj.startLine : 0;
  const maxLines = typeof obj.maxLines === "number" ? obj.maxLines : undefined;
 // No window requested → the full cached body is exactly right.
  if (startLine === 0 && maxLines === undefined) return cached;

  const nl = cached.indexOf("\n");
  if (nl < 0) return cached;
  const header = cached.slice(0, nl);
  const m = READ_FILE_HEADER.exec(header);
  if (!m) return cached;
  const totalLines = Number(m[1]);
 // 1-based inclusive range the cached body covers (full file when absent).
  const bodyFrom = m[2] ? Number(m[2]) : 1;
  const bodyTo = m[3] ? Number(m[3]) : totalLines;

 // Requested 1-based inclusive range.
  const wantFrom = startLine + 1;
  const wantTo = maxLines === undefined ? totalLines : Math.min(startLine + maxLines, totalLines);
 // Cache doesn't cover the request (e.g. cached a small window, caller wants
 // beyond it) → serve the whole cache rather than fabricate lines.
  if (wantFrom < bodyFrom || wantFrom > bodyTo) return cached;

 // read_file joins header and body with a blank line ("header\n\nbody"), so
 // strip that separator before splitting — otherwise lines[0] is "" and the
 // window is off by one.
  const raw = cached.slice(nl + 1);
  const body = raw.startsWith("\n") ? raw.slice(1) : raw;
  const lines = body.split("\n");
 // lines[i] holds body line number (bodyFrom + i). wantFrom..wantTo inclusive.
  const offStart = wantFrom - bodyFrom;
  const offEndExclusive = Math.min(wantTo, bodyTo) - bodyFrom + 1;
  const slice = lines.slice(offStart, offEndExclusive).join("\n");
  const shown = `(${totalLines} lines; showing lines ${wantFrom}-${Math.min(wantTo, bodyTo)} — replayed from cache)`;
  return `${shown}\n\n${slice}`;
}

export interface DoomLoopCheck {
 /** The number of times this exact (tool, input) has been called so far
 * in this run, INCLUDING the current call. */
  count: number;
 /** True when we should refuse the call (model is clearly stuck). */
  refuse: boolean;
 /** True when we should warn but still execute. */
  warn: boolean;
 /** Human-readable message for the model. */
  message: string;
}

export const WARN_THRESHOLD = 3;
export const REFUSE_THRESHOLD = 4;

/** Path-level threshold for `read_file`. Only OVERLAPPING re-reads of the same
 * path count toward this; advancing/paging reads reset it. We WARN at this
 * count and never refuse — a path read is never a hard loop (see header). */
export const PATH_WARN_THRESHOLD = 3;

/** Sequence-loop detection window. We look at the last SEQ_WINDOW
 * signatures (including the one being checked) and compare against the
 * SEQ_WINDOW signatures immediately before them. If ≥ SEQ_REPEAT of the
 * recent signatures already appeared in that prior window, the model is
 * re-walking a batch of calls — a rotating loop. */
export const SEQ_WINDOW = 6;
export const SEQ_REPEAT = 4;

/**
 * Idempotent-call result cache. Extracted from DoomLoopDetector so it can
 * outlive a single run: a `read_file`/`grep`/`ls`/`glob` result cached in one
 * prompt is replayed in the next, instead of re-reading the same file every
 * time the user says "继续". The loop-detection COUNTERS still reset per run
 * (a fresh prompt is a legitimate new turn), but the cached bodies persist.
 */
export class DedupCache {
 /** Tools whose results are safe to replay when called again with identical
 * input: they observe filesystem state the agent has not written to since.
 * `bash` is deliberately excluded — a repeated command may observe changed
 * state. `read_artifact` is excluded too: it IS the explicit recovery
 * channel for folded content. */
  private dedupable = new Set(["ls", "glob", "grep", "read_file"]);
  private resultCache = new Map<string, { content: string; artifactRef?: string }>();
 /** Path-keyed cache for read_file: any successful read of a path is
 * replayed for later windowed reads of the same path. */
  private pathResultCache = new Map<string, { content: string; artifactRef?: string }>();

  isDedupable(toolName: string): boolean {
    return this.dedupable.has(toolName);
  }

  cachedResult(toolName: string, input: unknown): { content: string; artifactRef?: string } | undefined {
    if (!this.dedupable.has(toolName)) return undefined;
    const exact = this.resultCache.get(signature(toolName, input));
    if (exact) return exact;
    const pk = pathKey(toolName, input);
    if (!pk) return undefined;
    const cached = this.pathResultCache.get(pk);
    if (!cached) return undefined;
    return { content: sliceWindow(cached.content, input), artifactRef: cached.artifactRef };
  }

  cachedResultKind(toolName: string, input: unknown): "exact" | "path" | null {
    if (!this.dedupable.has(toolName)) return null;
    if (this.resultCache.has(signature(toolName, input))) return "exact";
    const pk = pathKey(toolName, input);
    if (pk && this.pathResultCache.has(pk)) return "path";
    return null;
  }

  recordResult(toolName: string, input: unknown, result: { content: string; artifactRef?: string; isError?: boolean }): void {
    if (!this.dedupable.has(toolName)) return;
    if (result.isError) return;
 // Never cache compaction fold stubs: replaying one would make the blind
 // spot permanent — the model would keep re-receiving "[folded tool_result]".
    if (result.content.startsWith("[folded tool_result")) return;
    const entry = { content: result.content, artifactRef: result.artifactRef };
    this.resultCache.set(signature(toolName, input), entry);
    const pk = pathKey(toolName, input);
    if (pk) {
      const prev = this.pathResultCache.get(pk);
 // Prefer the longer body (full file over a small window).
      if (!prev || result.content.length >= prev.content.length) {
        this.pathResultCache.set(pk, entry);
      }
    }
  }

 /** A tool that can change the workspace ran: cached reads are now stale. */
  clear(): void {
    this.resultCache.clear();
    this.pathResultCache.clear();
  }
}

export class DoomLoopDetector {
  private counts = new Map<string, number>();
 /** Ordered list of call signatures across the whole run, for
 * sequence-level (rotating) loop detection. */
  private seq: string[] = [];
 /** Per-path OVERLAPPING-read counts (read_file only). Only re-reads that
 * cover ground already read bump this; advancing/paging reads reset it. */
  private pathCounts = new Map<string, number>();
 /** Per-path list of line windows already read, to tell a spiral (overlapping
 * re-read) apart from legitimate paging (advancing, non-overlapping). */
  private pathWindows = new Map<string, Array<{ from: number; to: number }>>();
 /** Fingerprints of questions the user has ALREADY answered this run. A new
 * ask whose questions are all in here is a redundant re-ask (info already
 * in hand) and is refused — regardless of how many times it happened. */
  private answeredQuestions = new Set<string>();
 /** Result cache. Injected by the session so it survives across prompts;
 * defaults to a run-local cache when none is supplied (tests, subagents). */
  private readonly cache: DedupCache;

  constructor(cache?: DedupCache) {
    this.cache = cache ?? new DedupCache();
  }

 /** Thresholds exposed as static constants for callers that need to
 * peek without incrementing (e.g. post-execution warn checks). */
  static readonly WARN_THRESHOLD = WARN_THRESHOLD;
  static readonly REFUSE_THRESHOLD = REFUSE_THRESHOLD;
  static readonly PATH_WARN_THRESHOLD = PATH_WARN_THRESHOLD;
  static readonly PATH_OVERLAP_THRESHOLD = PATH_OVERLAP_THRESHOLD;
  static readonly SEQ_WINDOW = SEQ_WINDOW;
  static readonly SEQ_REPEAT = SEQ_REPEAT;

 /** Record a tool call and return whether it should be warned/refused.
 *
 * NOTE: this records the call (increments counts, appends to the
 * sequence) BEFORE deciding, so a refused call still counts toward
 * future detection. Callers that refuse must NOT execute the tool. */
  check(toolName: string, input: unknown): DoomLoopCheck {
    const sig = signature(toolName, input);
    const count = (this.counts.get(sig) ?? 0) + 1;
    this.counts.set(sig, count);
    this.seq.push(sig);

 // Interactive-question guard: refuse re-asking a question the user has
 // ALREADY answered this run. The judgement is "is the information already
 // in hand", NOT "how many times" — one redundant ask is still wrong. We
 // fingerprint each question by its normalized text (digits/punctuation/
 // option noise stripped) so reworded or re-id'd repeats (fire→fire2, extra
 // whitespace, added data lines) still match a prior answered question.
    if (toolName === "ask_user_question") {
      const fps = questionFingerprints(input);
      const isReAsk = (f: string): boolean => {
        for (const prev of this.answeredQuestions) {
          if (questionSimilarity(f, prev) >= QUESTION_SIMILARITY_THRESHOLD) return true;
        }
        return false;
      };
      if (fps.length > 0 && fps.every(isReAsk)) {
        return {
          count: 1,
          refuse: true,
          warn: false,
          message:
            `You already have the user's answer to this question — do not ask it again ` +
            `(even reworded). Act on the answer you received and continue. If the user ` +
            `declined or gave no answer, pick the most reasonable default, note the ` +
            `assumption briefly, and complete the task.`,
        };
      }
    }

    const pk = pathKey(toolName, input);
    let pathCount = 0;
    if (pk) {
      // Distinguish a fold-induced spiral (re-reading ground already read)
      // from legitimate paging (advancing through a large file). Only a window
      // that highly OVERLAPS a previously-read window counts toward the budget;
      // a fresh region is progress and RESETS the count (plus records itself).
      const req = readWindow(input);
      const prior = this.pathWindows.get(pk) ?? [];
      const overlapping =
        req !== null &&
        prior.some((w) => windowOverlapFraction(req, w) >= PATH_OVERLAP_THRESHOLD);
      if (overlapping) {
        pathCount = (this.pathCounts.get(pk) ?? 0) + 1;
        this.pathCounts.set(pk, pathCount);
      } else {
        pathCount = 1;
        this.pathCounts.set(pk, 1);
        if (req) {
          // Keep a bounded history of recent windows for this path.
          prior.push(req);
          if (prior.length > 12) prior.shift();
          this.pathWindows.set(pk, prior);
        }
      }
    }

 // Layer 1: per-signature repetition.
    if (count >= REFUSE_THRESHOLD) {
      return {
        count,
        refuse: true,
        warn: false,
        message:
          `doom_loop: you've called ${toolName} with the exact same input ${count} times ` +
          `without making progress. This is almost certainly a loop — STOP and try a ` +
          `fundamentally different approach. Re-read the relevant files, check your ` +
          `assumptions, or ask the user for guidance.`,
      };
    }

 // Layer 2: sequence-level (rotating) loop.
    const seqHit = this.checkSequence();
    if (seqHit) {
      return {
        count,
        refuse: true,
        warn: false,
        message:
          `doom_loop: you're repeating a batch of tool calls you already made in the same ` +
          `form (${seqHit} recent calls match earlier ones). You are re-exploring the same ` +
          `ground without making progress. STOP re-calling tools you've already used with ` +
          `the same arguments — use the results you already have, move on to the next step ` +
          `of your plan, or summarize what you've learned so far.`,
      };
    }

    if (count >= WARN_THRESHOLD) {
      return {
        count,
        refuse: false,
        warn: true,
        message:
          `doom_loop warning: this is the ${count}rd time you're calling ${toolName} with ` +
          `identical input. If the previous calls didn't solve the problem, repeating ` +
          `them won't either. Consider a different approach.`,
      };
    }

    if (pk && pathCount >= PATH_WARN_THRESHOLD) {
      return {
        count,
        refuse: false,
        warn: true,
        message:
          `doom_loop warning: you've re-read an OVERLAPPING window of the same file ` +
          `${pathCount} times — you keep re-fetching lines you already have. Reading a ` +
          `NEW (non-overlapping) part of the file is fine; re-reading the same region is ` +
          `not. Use the earlier result (or read_artifact if it was folded) for lines you ` +
          `already saw, or read a different range.`,
      };
    }

    return { count, refuse: false, warn: false, message: "" };
  }

 /** Sequence-level rotating-loop check. Looks at the most recent
 * SEQ_WINDOW signatures and counts how many also appear in the
 * SEQ_WINDOW-window immediately preceding them. Returns the overlap
 * count when it meets SEQ_REPEAT, else 0. */
  private checkSequence(): number {
    const w = SEQ_WINDOW;
    if (this.seq.length < w * 2) return 0;
    const recent = this.seq.slice(this.seq.length - w);
    const prior = this.seq.slice(this.seq.length - w * 2, this.seq.length - w);
    const priorSet = new Set(prior);
    let overlap = 0;
    for (const s of recent) if (priorSet.has(s)) overlap++;
    return overlap >= SEQ_REPEAT ? overlap : 0;
  }

 /** Return the current call count for a (tool, input) pair WITHOUT
 * incrementing. Used by post-execution code that only needs to know
 * whether to attach a warning, not to record a new call. */
  peekCount(toolName: string, input: unknown): number {
    const sig = signature(toolName, input);
    return this.counts.get(sig) ?? 0;
  }

 /** Record that the questions in an `ask_user_question` call have now been
 * answered, so a later re-ask of the same (or reworded) question is
 * refused by `check`. Called by the tool runner after a successful,
 * non-error ask. */
  markQuestionsAnswered(input: unknown): void {
    for (const fp of questionFingerprints(input)) this.answeredQuestions.add(fp);
  }

 // -------------------------------------------------------------------------
 // Idempotent-call de-duplication cache (delegated to the shared DedupCache
 // so results survive across prompts; see DedupCache above).
 // -------------------------------------------------------------------------

 /** True when this tool is eligible for result replay (idempotent read). */
  isDedupable(toolName: string): boolean {
    return this.cache.isDedupable(toolName);
  }

 /** Return a cached successful result for an identical prior call, if any. */
  cachedResult(toolName: string, input: unknown): { content: string; artifactRef?: string } | undefined {
    return this.cache.cachedResult(toolName, input);
  }

 /** Whether the cache hit was path-keyed (different window) vs exact. */
  cachedResultKind(toolName: string, input: unknown): "exact" | "path" | null {
    return this.cache.cachedResultKind(toolName, input);
  }

 /** Record a successful result so a future identical call can replay it. */
  recordResult(toolName: string, input: unknown, result: { content: string; artifactRef?: string; isError?: boolean }): void {
    this.cache.recordResult(toolName, input, result);
  }

 /** A tool that can change the workspace ran: cached reads are stale, and
 * re-reading a file after editing it is progress, not a loop. */
  noteMutation(): void {
    this.cache.clear();
    this.pathCounts.clear();
    this.pathWindows.clear();
    for (const sig of [...this.counts.keys()]) {
      const tool = sig.slice(0, sig.indexOf("::"));
      if (this.cache.isDedupable(tool)) this.counts.delete(sig);
    }
  }

 /** Reset all counters (e.g. at the start of a new run). Does NOT clear the
 * shared result cache — that is intentionally persistent across prompts. */
  reset(): void {
    this.counts.clear();
    this.seq.length = 0;
    this.pathCounts.clear();
    this.pathWindows.clear();
    this.answeredQuestions.clear();
  }
}
