// Inline (Tab) code completion provider.
//
// Design: docs/design/G-inline-completion.md. All model/prompt logic lives in
// core/protocol behind the `completion/inline` RPC; this host-side provider is
// thin: collect capped prefix/suffix → RPC → render ghost text → cancel. The
// latency machinery (debounce, cancel, client-side LRU cache, prefix/suffix cap)
// is owned here per §5/§5.1 — the server handler stays stateless.

import * as vscode from "vscode";

import type { CodepilotSettings } from "./config.js";
import type { Engine } from "./engine.js";

/** Context caps (design §5). Bounds tokens/latency and stabilises the cache key. */
const PREFIX_CAP = 4000;
const SUFFIX_CAP = 2000;
/** Small client LRU — the hit that matters is backspace/retype (§5.1). */
const CACHE_MAX = 64;
/** Hard ceiling on the server round-trip so a stale request can't hang. */
const REQUEST_TIMEOUT_MS = 8000;

interface InlineCompletionResult {
  completion: string;
  requestId: string;
  disabledReason?: string;
}

export class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private seq = 0;
  private readonly cache = new Map<string, string>();
  /** Debounce timer shared across keystrokes — only the last pause fires. */
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** One-time notice when the user has no distinct small/completion model. */
  private warnedNoSmallModel = false;

  constructor(
    private readonly engine: Engine,
    private readonly settings: () => CodepilotSettings,
    private readonly cwd: () => string,
    private readonly notify: (message: string) => void,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = this.settings().completion;
    if (!cfg.enabled) return undefined;

    // Trigger gating (§5): skip when a selection is active, on an empty doc, or
    // when there is nothing before the cursor to continue from.
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) return undefined;

    const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    if (fullPrefix.trim() === "") return undefined;
    const lastLine = document.lineAt(document.lineCount - 1).range.end;
    const fullSuffix = document.getText(new vscode.Range(position, lastLine));

    const prefix = fullPrefix.length > PREFIX_CAP ? fullPrefix.slice(-PREFIX_CAP) : fullPrefix;
    const suffix = fullSuffix.length > SUFFIX_CAP ? fullSuffix.slice(0, SUFFIX_CAP) : fullSuffix;
    const path = vscode.workspace.asRelativePath(document.uri);

    // Client cache: a hit returns instantly with NO RPC round-trip (§5.1).
    const key = cacheKey(path, prefix, suffix);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.touch(key, cached);
      return cached ? [this.item(cached, position)] : undefined;
    }

    if (token.isCancellationRequested) return undefined;

    // Debounce: wait for a typing pause; a new keystroke supersedes this one.
    const debounced = await this.debounce(cfg.debounceMs, token);
    if (!debounced || token.isCancellationRequested) return undefined;
    if (!this.engine.running) return undefined;

    const requestId = `c${++this.seq}`;
    let res: InlineCompletionResult;
    try {
      res = await this.engine.request<InlineCompletionResult>(
        "completion/inline",
        {
          prefix,
          suffix,
          path,
          requestId,
          cwd: this.cwd(),
          maxTokens: cfg.maxTokens,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS, signal: toAbortSignal(token) },
      );
    } catch {
      // Fast-fail: any error (timeout / abort / rate-limit) → no suggestion.
      return undefined;
    }
    if (token.isCancellationRequested) return undefined;

    if (res.disabledReason === "no-small-model") {
      this.warnNoSmallModelOnce();
      return undefined;
    }

    const text = res.completion ?? "";
    this.touch(key, text);
    return text ? [this.item(text, position)] : undefined;
  }

  private item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  }

  private debounce(ms: number, token: vscode.CancellationToken): Promise<boolean> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    return new Promise<boolean>((resolve) => {
      const onCancel = token.onCancellationRequested(() => {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
        onCancel.dispose();
        resolve(false);
      });
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        onCancel.dispose();
        resolve(true);
      }, Math.max(0, ms));
    });
  }

  private touch(key: string, value: string): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private warnNoSmallModelOnce(): void {
    if (this.warnedNoSmallModel) return;
    this.warnedNoSmallModel = true;
    this.notify(
      "CodePilot completion needs a lightweight model distinct from your main chat model. " +
        "Configure `smallModel` (or `completion.model`) — e.g. a local Ollama `qwen2.5-coder`, " +
        "or a free Groq / Gemini Flash model.",
    );
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.cache.clear();
  }
}

function cacheKey(path: string, prefix: string, suffix: string): string {
  // Tail of prefix + head of suffix is what determines the completion; hashing
  // keeps the key bounded and stable under the context cap.
  return `${path}\u0000${hash(prefix.slice(-512))}\u0000${hash(suffix.slice(0, 256))}`;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const ctl = new AbortController();
  if (token.isCancellationRequested) ctl.abort();
  else token.onCancellationRequested(() => ctl.abort());
  return ctl.signal;
}
