/**
 * Terminal rendering for `codepilot run` / `goal` / the REPL when stderr is
 * a TTY: the same glyphs, verbs and palette as the TUI and the graphical
 * clients. Pipes and `NO_COLOR` keep the plain `[tool:…]` format, which is
 * easier to grep.
 */

import { stripThinking, type Event } from "@codepilot/core";

const PALETTE = {
  accent: [139, 124, 255],
  add: [63, 185, 127],
  remove: [240, 97, 109],
  warn: [232, 176, 74],
  faint: [107, 115, 134],
} as const;

type Tone = keyof typeof PALETTE;

const VERBS: Array<[RegExp, string, string]> = [
  [/^(read_file|read|view|read_artifact|read_image)$/, "Read", "Reading"],
  [/^(ls|list_dir)$/, "Listed", "Listing"],
  [/^(grep|glob|search|code_search|semantic_search)$/, "Searched", "Searching"],
  [/^(edit_file|edit|multi_edit|apply_patch|str_replace|notebook_edit)$/, "Edited", "Editing"],
  [/^(write_file|write|create_file)$/, "Wrote", "Writing"],
  [/^(bash|shell|run_command|bash_output|write_stdin)$/, "Ran", "Running"],
  [/^(web_fetch|fetch|web_search)$/, "Fetched", "Fetching"],
  [/^(task|spawn_agent|team|skill)$/, "Delegated", "Delegating"],
  [/^(memory_write|remember|memory)$/, "Saved memory", "Saving memory"],
];

function verbs(name: string): [string, string] {
  for (const [re, done, active] of VERBS) if (re.test(name)) return [done, active];
  return [name, name];
}

function target(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "objective", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
    }
  }
  return "";
}

export function prettyOutput(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return stream.isTTY === true || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0");
}

export class PrettyRenderer {
  private calls = new Map<string, { name: string; target: string; at: number }>();
  private textOpen = new Set<string>();
 /** Raw assistant text per message id (includes think blocks). */
  private textBuf = new Map<string, string>();
 /** How many chars of stripThinking(buf) have already been written. */
  private textShown = new Map<string, number>();
 /** The last line is a "running" placeholder that a result may replace. */
  private pendingLine: string | null = null;
  private atLineStart = true;
 /** Message ids for which we've already printed the "thinking" header. */
  private reasoningOpen = new Set<string>();

  constructor(private readonly out: { write(s: string): unknown }) {}

  render(e: Event): void {
    switch (e.type) {
      case "message_delta":
        if (e.delta.type === "text") this.text(e.messageId, e.delta.text);
        else if (e.delta.type === "reasoning") this.reasoning(e.messageId, e.delta.text);
        return;
      case "message":
        if (e.role === "assistant" && !this.textOpen.has(e.id)) {
          const text = e.content.map((b) => (b.type === "text" ? b.text : "")).join("");
          if (text.trim() !== "") this.text(e.id, text);
        }
        this.textOpen.delete(e.id);
        this.textBuf.delete(e.id);
        this.textShown.delete(e.id);
        this.reasoningOpen.delete(e.id);
        return;
      case "tool_call": {
        if (e.name === "plan_update") return;
        const t = target(e.input);
        this.calls.set(e.id, { name: e.name, target: t, at: Date.now() });
        const [, active] = verbs(e.name);
        this.line(`  ${this.tint("accent", "●")} ${this.tint("faint", active)}${t ? ` ${t}` : ""}`, e.id);
        return;
      }
      case "tool_result": {
        const call = this.calls.get(e.toolCallId);
        if (!call && e.name === "plan_update") return;
        this.calls.delete(e.toolCallId);
        const [done] = verbs(call?.name ?? e.name);
        const took = call ? Date.now() - call.at : 0;
        const time = took >= 100 ? this.tint("faint", ` · ${took < 1000 ? `${took}ms` : `${(took / 1000).toFixed(1)}s`}`) : "";
        const mark = e.isError ? this.tint("remove", "✗") : this.tint("add", "✓");
        const text = `  ${mark} ${this.tint("faint", done)}${call?.target ? ` ${call.target}` : ""}${time}`;
        this.line(text, e.toolCallId, true);
        if (e.isError) {
          const first = e.content.split("\n").find((l) => l.trim() !== "") ?? "";
          if (first) this.line(`    ${this.tint("remove", `│ ${first.slice(0, 160)}`)}`);
        }
        return;
      }
      case "plan": {
        const done = e.steps.filter((s) => s.status === "completed").length;
        const current = e.steps.find((s) => s.status === "in_progress");
        this.line(this.tint("faint", `  ◐ plan ${done}/${e.steps.length}${current ? ` · ${current.title}` : ""}`));
        return;
      }
      case "compaction":
        this.line(
          this.tint(
            "faint",
            e.kind === "micro-fold"
              ? "  ⟳ Archived large results (retrievable)"
              : "  ⟳ Context compacted",
          ),
        );
        return;
      case "error":
        this.line(`${this.tint(e.recoverable ? "warn" : "remove", e.recoverable ? "▲" : "✗")} ${e.message}`);
        return;
      case "retry":
        this.line(
          `${this.tint("warn", `↻ Retrying (${e.attempt}/${e.maxAttempts})${e.delayMs > 0 ? ` in ${Math.round(e.delayMs / 100) / 10}s` : ""}`)}${this.tint("faint", ` · ${e.reason.slice(0, 120)}`)}`,
        );
        return;
      case "team_message":
        this.line(this.tint("faint", `  ⇄ ${e.kind ?? "msg"} · ${e.from} → ${e.to}`));
        return;
      default:
        return;
    }
  }

 /** Stream extended-thinking dimmed, under a one-time "thinking" header, so
  * it reads as a muted preamble distinct from the answer. */
  private reasoning(id: string, chunk: string): void {
    if (!chunk) return;
    if (!this.reasoningOpen.has(id)) {
      this.reasoningOpen.add(id);
      this.breakLine();
      this.out.write(`\n${this.tint("faint", "· thinking")}\n`);
      this.atLineStart = true;
    }
    this.out.write(this.tint("faint", chunk));
    this.pendingLine = null;
    this.atLineStart = chunk.endsWith("\n");
  }

  private text(id: string, chunk: string): void {
    const full = (this.textBuf.get(id) ?? "") + chunk;
    this.textBuf.set(id, full);
    const visible = stripThinking(full);
    const shown = this.textShown.get(id) ?? 0;
    const delta = visible.length >= shown ? visible.slice(shown) : visible;
    if (!delta) {
      this.textShown.set(id, visible.length);
      return;
    }
    if (!this.textOpen.has(id)) {
      this.textOpen.add(id);
      this.breakLine();
      this.out.write(`\n${this.tint("accent", "◆")} `);
      this.pendingLine = null;
    }
    this.out.write(delta);
    this.textShown.set(id, visible.length);
    this.atLineStart = delta.endsWith("\n");
  }

 /** Write a full line; `replace` overwrites the matching placeholder in place. */
  private line(text: string, key?: string, replace = false): void {
    if (replace && key !== undefined && this.pendingLine === key) {
      this.out.write(`\r\u001b[2K${text}\n`);
    } else {
      this.breakLine();
      this.out.write(`${text}\n`);
    }
    this.pendingLine = !replace && key !== undefined ? key : null;
    this.atLineStart = true;
  }

  private breakLine(): void {
    if (!this.atLineStart) {
      this.out.write("\n");
      this.atLineStart = true;
    }
  }

  private tint(tone: Tone, s: string): string {
    const [r, g, b] = PALETTE[tone];
    return `\u001b[38;2;${r};${g};${b}m${s}\u001b[39m`;
  }
}
