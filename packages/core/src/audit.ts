// Structured audit log.
//
// Records every tool call, its outcome, permission denials and errors as
// append-only JSONL under `~/.codepilot/audit/<YYYY-MM-DD>.jsonl` (or a
// configured directory). The logger is DRIVEN BY THE EVENT STREAM, not by
// instrumenting the tool hot path: a session subscribes it to its events, so
// it captures every tool call/result across all code paths with no risk of
// missing an early return. Secrets never reach it — the agent loop redacts
// tool results before they become events, and we only keep a short,
// primary-argument summary of inputs (not the full object).

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Event } from "./types.js";

/** One structured audit record (JSONL line). */
export interface AuditRecord {
 /** ISO-8601 timestamp. */
  ts: string;
  sessionId: string;
  type: "tool_call" | "tool_result" | "error" | "permission" | "compaction";
 /** Tool name for tool_call / tool_result records. */
  tool?: string;
 /** Short, redaction-safe summary of the primary argument. */
  input?: string;
 /** Opaque id correlating a tool_call with its tool_result. */
  toolCallId?: string;
 /** True when the tool returned / threw an error. */
  isError?: boolean;
 /** Length of the (already-redacted) result text. */
  resultChars?: number;
 /** Free-form message for error / permission records. */
  message?: string;
}

/** Where the audit log lives. */
export function auditDir(): string {
  return join(homedir(), ".codepilot", "audit");
}

function auditFileFor(date = new Date()): string {
  const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(auditDir(), `${day}.jsonl`);
}

/** Pull a short, secret-free summary of a tool's primary argument. */
function summariseInput(input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "objective", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
    }
  }
  return undefined;
}

/**
 * Append-only structured audit logger. Subscribe {@link onEvent} to a
 * session's event stream. Writes are fire-and-forget and never throw into the
 * caller (audit must not break the agent); failures are swallowed after a
 * single stderr notice.
 */
export class AuditLogger {
  private readonly sessionId: string;
  private readonly file: string;
  private warned = false;
 /** Remembers tool names by call id so tool_result records can name the tool. */
  private readonly callNames = new Map<string, string>();

  constructor(sessionId: string, opts: { dir?: string; file?: string } = {}) {
    this.sessionId = sessionId;
    this.file = opts.file ?? (opts.dir ? join(opts.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`) : auditFileFor());
  }

  /** Event-stream sink. Safe to pass directly to `session.subscribe`. */
  onEvent = (e: Event): void => {
    const rec = this.toRecord(e);
    if (rec) void this.write(rec);
  };

  private toRecord(e: Event): AuditRecord | null {
    const ts = new Date().toISOString();
    switch (e.type) {
      case "tool_call":
        this.callNames.set(e.id, e.name);
        return { ts, sessionId: this.sessionId, type: "tool_call", tool: e.name, toolCallId: e.id, input: summariseInput(e.input) };
      case "tool_result":
        return {
          ts,
          sessionId: this.sessionId,
          type: "tool_result",
          tool: this.callNames.get(e.toolCallId),
          toolCallId: e.toolCallId,
          isError: e.isError === true,
          resultChars: typeof e.content === "string" ? e.content.length : undefined,
        };
      case "error":
        return { ts, sessionId: this.sessionId, type: "error", message: e.message.slice(0, 500) };
      case "compaction":
        return { ts, sessionId: this.sessionId, type: "compaction" };
      default:
        return null; // message / message_delta / status / usage / plan etc. are not audited
    }
  }

  private async write(rec: AuditRecord): Promise<void> {
    try {
      await mkdir(auditDir(), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(rec)}\n`, "utf-8");
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`[audit] write failed (further errors suppressed): ${(err as Error).message}\n`);
      }
    }
  }
}

/**
 * Read audit records, newest-day first by default. Used for export / review.
 * `sessionId` filters to one session; `limit` caps the returned count.
 */
export async function readAuditLog(
  opts: { dir?: string; sessionId?: string; limit?: number } = {},
): Promise<AuditRecord[]> {
  const dir = opts.dir ?? auditDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const out: AuditRecord[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(line) as AuditRecord;
      } catch {
        continue; // tolerate a torn final line
      }
      if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
      out.push(rec);
      if (opts.limit && out.length >= opts.limit) return out;
    }
  }
  return out;
}
