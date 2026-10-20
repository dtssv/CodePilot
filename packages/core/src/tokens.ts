// Token estimation + per-model context windows.
//
// Tokenizer strategy
// ------------------
// `estimateTokens` is the single primitive every budget decision routes
// through. It delegates to a swappable *active tokenizer*:
//
// - By default this is `heuristicTokens`, a zero-dependency character-class
//   scan (below). It needs no model-specific tables and stays within a sane
//   error band across CJK / English / code / JSON — good enough for
//   compaction thresholds without shipping a 1MB+ BPE blob.
// - Hosts that want provider-accurate counts call `tryLoadRealTokenizer()`,
//   which dynamically imports the optional pure-JS `gpt-tokenizer` package
//   (o200k_base — GPT-4o / 4.1 / 5) *if it is installed* and installs it as
//   the active tokenizer. Core does NOT declare that dependency, so the
//   default build stays single-dependency; the loader is a no-op (keeps the
//   heuristic) when the package is absent.
// - `setTokenizer` / `resetTokenizer` let embedders plug in any counter
//   (e.g. a provider's own tokenizer) or restore the default.
//
// The heuristic is intentionally monotonic (longer text → equal-or-more
// tokens) and rounds up so a one-character string claims at least 1 token.

/** A single estimator. Pure, total, no allocation beyond locals. */
export type TokenEstimator = (text: string) => number;

/** The active tokenizer. Swappable via setTokenizer; defaults to heuristic. */
let activeTokenizer: TokenEstimator = heuristicTokens;

/** Install a custom tokenizer for all subsequent estimation. */
export function setTokenizer(fn: TokenEstimator): void {
  activeTokenizer = fn;
}

/** Restore the built-in zero-dependency heuristic tokenizer. */
export function resetTokenizer(): void {
  activeTokenizer = heuristicTokens;
}

/** The tokenizer currently in effect. */
export function getActiveTokenizer(): TokenEstimator {
  return activeTokenizer;
}

/** True once a real (non-heuristic) tokenizer has been installed. */
export function hasRealTokenizer(): boolean {
  return activeTokenizer !== heuristicTokens;
}

/**
 * Best-effort: install a provider-accurate tokenizer if the optional
 * `gpt-tokenizer` package is available. Returns true when a real tokenizer
 * is now active, false when it stayed on the heuristic (package missing or
 * failed to load). Safe to call more than once and safe to call when the
 * package was never installed — it never throws.
 */
export async function tryLoadRealTokenizer(): Promise<boolean> {
  if (hasRealTokenizer()) return true;
  try {
    // o200k_base covers GPT-4o / 4.1 / 5 and is a close proxy for Claude /
    // other modern models — far better than the heuristic for all of them.
    // The specifier is built indirectly so the optional, undeclared package
    // does not become a compile-time dependency (tsc won't try to resolve it).
    const spec = "gpt-tokenizer";
    const importer = new Function("s", "return import(s)") as (s: string) => Promise<unknown>;
    const mod = (await importer(spec)) as {
      encode?: (text: string) => number[];
      default?: { encode?: (text: string) => number[] };
    };
    const encode = mod.encode ?? mod.default?.encode;
    if (typeof encode !== "function") return false;
    setTokenizer((text) => (text ? encode(text).length : 0));
    return true;
  } catch {
    return false; // package not installed — keep the heuristic
  }
}

/** Estimate tokens for a single text string (via the active tokenizer). */
export function estimateTokens(text: string): number {
  return activeTokenizer(text);
}

/**
 * Zero-dependency heuristic tokenizer — a character-class scan:
 *
 * - CJK / wide characters: 1 token per character
 * - latin / cyrillic / greek letter runs ("words"): ~0.75 tokens per word
 * - digits grouped with letters/underscores (identifiers): part of the word
 * - code / JSON punctuation: ~1 token per 3 characters
 * - whitespace: 0 tokens on its own
 *
 * Not meant to match a specific provider's BPE table; see the module header
 * for the accurate opt-in path.
 */
export function heuristicTokens(text: string): number {
  if (!text) return 0;
 // Fast path: a whitespace-only string contributes 0 tokens. Skipping
 // the loop here also avoids the `Math.max(1, ...)` floor for
 // paragraphs of pure formatting.
  if (text.trim().length === 0) return 0;
  let cjk = 0;
  let word = 0;
  let code = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code_ = text.charCodeAt(i);
 // CJK Unified Ideographs, Hiragana, Katakana, Hangul, fullwidth, etc.
    if (isCjkChar(code_)) {
      if (inWord) {
        word += 1;
        inWord = false;
      }
      cjk += 1;
      continue;
    }
 // Letters / digits / underscore that form "words" (identifiers, English).
    if (isWordChar(ch)) {
      if (!inWord) {
        word += 1;
        inWord = true;
      }
      continue;
    }
 // End a word if we just hit a non-word.
    if (inWord) inWord = false;
 // Code punctuation: count every 3rd char as one token. Cheaper than
 // counting every brace and is close enough for the budget decisions
 // compaction makes.
    if (isCodeChar(code_)) {
      code += 1;
    }
  }
  if (inWord) inWord = false;
 // cjk: 1 token per character. words: 0.75 tokens per word. code punctuation
 // is 1 token per 3 characters. round up so a one-character string still
 // claims at least 1 token.
  const est = cjk + word * 0.75 + code / 3;
  return Math.max(1, Math.ceil(est));
}

function isCjkChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0x3400 && code <= 0x4dbf) || // Ext A
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth
    (code >= 0x3000 && code <= 0x303f) // CJK symbols
  );
}

function isWordChar(ch: string): boolean {
 // a-z A-Z 0-9 _ and most unicode letter/digit code points.
  const c = ch.charCodeAt(0);
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f) {
    return true;
  }
 // Greek / Cyrillic / Latin extended.
  if ((c >= 0x0370 && c <= 0x03ff) || (c >= 0x0400 && c <= 0x04ff) || (c >= 0xc0 && c <= 0x024f)) {
    return true;
  }
  return false;
}

function isCodeChar(code: number): boolean {
 // {}[]<>:=;,.+-/*&|^!~?`'"@#$\\
  return "{}[]()<>:=;,.+-/*&|^!~?`'\"@#$\\".includes(String.fromCharCode(code));
}

/** Estimate tokens for an array of provider-shaped messages. */
export function estimateMessagesTokens(
  messages: ReadonlyArray<{ role: string; content: string | ReadonlyArray<Record<string, unknown>> }>
): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message framing overhead (role + delimiters)
    const c = m.content;
    if (typeof c === "string") {
      total += estimateTokens(c);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
          total += estimateTokens(b.text);
        } else if (b && typeof b === "object" && b.type === "image") {
          total += 1_600;
        } else {
          total += estimateTokens(JSON.stringify(b));
        }
      }
    }
  }
  return total;
}

/** Estimate tokens for a serialised block (used for tool results, plan, etc.). */
export function estimateObjectTokens(value: unknown): number {
  if (value == null) return 0;
  return estimateTokens(typeof value === "string" ? value : JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Per-model context windows.
//
// The map below is the canonical source of truth for the models we ship
// out-of-the-box. Unknown models fall back to a configurable default.
// ---------------------------------------------------------------------------

export interface ModelContextWindow {
 /** Total context window in tokens (input + output). */
  contextWindow: number;
 /** Soft cap for "should I plan to compact?" — defaults to 80% of context. */
  compactionThreshold: number;
 /** Maximum output tokens the model can produce per turn (best-effort). */
  maxOutputTokens: number;
}

/** Look up the context window for a model id, falling back to a default. */
export function lookupContextWindow(
  model: string | undefined,
  fallback = 128_000
): ModelContextWindow {
  const id = (model ?? "").toLowerCase().trim();
  const m = MODEL_CONTEXT_WINDOWS.find((entry) => entry.match(id));
  if (m) {
    return m.window;
  }
  const threshold = Math.floor(fallback * 0.8);
  return {
    contextWindow: fallback,
    compactionThreshold: threshold,
    maxOutputTokens: 4096,
  };
}

/** Resolve the effective compaction threshold. Config override > 80% of model. */
export function resolveCompactionThreshold(
  model: string | undefined,
  configWindow: number | undefined
): number {
  if (typeof configWindow === "number" && configWindow > 0) {
    return Math.floor(configWindow * 0.8);
  }
  return lookupContextWindow(model).compactionThreshold;
}

// ---------------------------------------------------------------------------
// Cost estimation (USD per 1M tokens, public list prices as of 2025)
// ---------------------------------------------------------------------------

export interface ModelCost {
  input: number;
  output: number;
 /** Cache-read price when the provider reports it (Anthropic); defaults to input * 0.1. */
  cacheRead?: number;
}

const MODEL_COSTS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  { match: (id) => id.includes("claude-opus-4"), cost: { input: 15, output: 75, cacheRead: 1.5 } },
  { match: (id) => id.includes("claude-sonnet-4") || id.includes("claude-3-5-sonnet"), cost: { input: 3, output: 15, cacheRead: 0.3 } },
  { match: (id) => id.includes("claude-haiku"), cost: { input: 0.8, output: 4, cacheRead: 0.08 } },
  { match: (id) => id.includes("claude"), cost: { input: 3, output: 15 } },
  { match: (id) => id.includes("gpt-5-mini"), cost: { input: 0.25, output: 2 } },
  { match: (id) => id.includes("gpt-5"), cost: { input: 1.25, output: 10 } },
  { match: (id) => id.includes("gpt-4.1-mini"), cost: { input: 0.4, output: 1.6 } },
  { match: (id) => id.includes("gpt-4.1") || id.includes("gpt-4-1"), cost: { input: 2, output: 8 } },
  { match: (id) => id.includes("gpt-4o-mini"), cost: { input: 0.15, output: 0.6 } },
  { match: (id) => id.includes("gpt-4o"), cost: { input: 2.5, output: 10 } },
  { match: (id) => id.includes("deepseek"), cost: { input: 0.27, output: 1.1 } },
  { match: (id) => id.includes("qwen"), cost: { input: 0.3, output: 1.2 } },
  { match: (id) => id.includes("gemini-2.5-pro") || id.includes("gemini-1.5-pro"), cost: { input: 1.25, output: 10 } },
  { match: (id) => id.includes("gemini-2.5-flash") || id.includes("gemini-2.0-flash") || id.includes("gemini-1.5-flash"), cost: { input: 0.3, output: 2.5 } },
  { match: (id) => id.includes("gemini"), cost: { input: 0.3, output: 2.5 } },
];

/**
 * Estimate the USD cost of one usage record. Returns undefined when the
 * model is unknown — callers should treat undefined as "not priced", not
 * zero. Cache-write is priced at 1.25x input (Anthropic semantics);
 * cache-read uses the table's cacheRead or input * 0.1.
 */
export function estimateCostUSD(
  model: string | undefined,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
): number | undefined {
  const id = (model ?? "").toLowerCase().trim();
  const entry = MODEL_COSTS.find((e) => e.match(id));
  if (!entry) return undefined;
  const { input, output, cacheRead } = entry.cost;
  const m = 1_000_000;
  return (
    ((usage.input ?? 0) / m) * input +
    ((usage.output ?? 0) / m) * output +
    ((usage.cacheRead ?? 0) / m) * (cacheRead ?? input * 0.1) +
    ((usage.cacheWrite ?? 0) / m) * (input * 1.25)
  );
}

interface ModelEntry {
 /** Substring matcher — any model id containing this string matches. */
  match: (id: string) => boolean;
  window: ModelContextWindow;
}

// Note: ordering matters — most specific matchers first. The match helper
// receives a lowercased, trimmed model id.
const MODEL_CONTEXT_WINDOWS: ModelEntry[] = [
 // Claude (Anthropic).
  {
    match: (id) => id.includes("claude-opus-4-1") || id.includes("claude-opus-4.1"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("claude-opus-4") || id.includes("claude-4-opus"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("claude-sonnet-4-5") || id.includes("claude-3-5-sonnet"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("claude-sonnet-4") || id.includes("claude-4-sonnet"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("claude-haiku-4-5") || id.includes("claude-3-5-haiku"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("claude-haiku") || id.includes("claude-3-haiku"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("claude"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 4096 },
  },
 // OpenAI / GPT.
  {
    match: (id) => id.includes("gpt-4.1") || id.includes("gpt-4-1"),
    window: { contextWindow: 1_000_000, compactionThreshold: 800_000, maxOutputTokens: 16_384 },
  },
  {
    match: (id) => id.includes("gpt-4o-mini"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("gpt-4o"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("gpt-4-turbo"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("gpt-4") || id === "gpt4",
    window: { contextWindow: 8_192, compactionThreshold: 6_500, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("gpt-3.5") || id.includes("gpt-3"),
    window: { contextWindow: 16_385, compactionThreshold: 13_000, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("o1-mini") || id.includes("o3-mini"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 16_384 },
  },
  {
    match: (id) => id.includes("o1-preview") || id.includes("o1") || id.includes("o3"),
    window: { contextWindow: 200_000, compactionThreshold: 160_000, maxOutputTokens: 16_384 },
  },
 // DeepSeek.
  {
    match: (id) => id.includes("deepseek-v3") || id.includes("deepseek-chat"),
    window: { contextWindow: 64_000, compactionThreshold: 51_200, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("deepseek-r1") || id.includes("deepseek-reasoner"),
    window: { contextWindow: 64_000, compactionThreshold: 51_200, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("deepseek"),
    window: { contextWindow: 32_000, compactionThreshold: 25_600, maxOutputTokens: 4096 },
  },
 // GLM (Zhipu / Z.ai).
  {
    match: (id) => id.includes("glm-4-plus") || id.includes("glm-4-Plus"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("glm-4-long") || id.includes("glm-4-long"),
    window: { contextWindow: 1_000_000, compactionThreshold: 800_000, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("glm-4") || id.includes("glm4"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("glm-zero") || id.includes("glm-z1"),
    window: { contextWindow: 16_000, compactionThreshold: 12_800, maxOutputTokens: 4096 },
  },
  {
    match: (id) => id.includes("glm"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 4096 },
  },
 // Kimi (Moonshot).
  {
    match: (id) => id.includes("kimi-k2") || id.includes("moonshot-v1-128k") || id.includes("moonshot-v1-256k"),
    window: { contextWindow: 128_000, compactionThreshold: 102_400, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("kimi") || id.includes("moonshot"),
    window: { contextWindow: 32_000, compactionThreshold: 25_600, maxOutputTokens: 4096 },
  },
 // GitHub Copilot — typically a thin proxy over an OpenAI model.
  {
    match: (id) => id.startsWith("copilot-") || id.startsWith("copilot/"),
    window: { contextWindow: 64_000, compactionThreshold: 51_200, maxOutputTokens: 4096 },
  },
 // Google Gemini.
  {
    match: (id) => id.includes("gemini-2.5-pro") || id.includes("gemini-1.5-pro"),
    window: { contextWindow: 2_000_000, compactionThreshold: 1_600_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) =>
      id.includes("gemini-2.5-flash") || id.includes("gemini-2.0-flash") || id.includes("gemini-1.5-flash"),
    window: { contextWindow: 1_000_000, compactionThreshold: 800_000, maxOutputTokens: 8192 },
  },
  {
    match: (id) => id.includes("gemini"),
    window: { contextWindow: 1_000_000, compactionThreshold: 800_000, maxOutputTokens: 8192 },
  },
];

/** Sum of events' token estimates, using the segmented estimator by default. */
export function estimateEventsTokens<T>(
  events: ReadonlyArray<T>,
  serialize: (e: T) => string | number
): number {
  let total = 0;
  for (const e of events) {
    const s = serialize(e);
    if (typeof s === "number") total += s;
    else total += estimateTokens(s);
  }
  return total;
}
