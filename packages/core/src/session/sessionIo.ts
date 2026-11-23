import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";
import type { Event } from "../types.js";
import {
  SESSIONS_DIR,
  compressedSessionPath,
  cwdSidecarPath,
  historyArchivePath,
  inboxSidecarPath,
  normalizeCwd,
  sessionPath,
  stateSidecarPath,
  titleSidecarPath,
} from "./sessionPaths.js";

/** Per-session UI state persisted in a `<id>.state` sidecar (JSON). Separate
 * from the JSONL event log so toggling pin/archive is a cheap single-file
 * write and the SQLite index (which folds sidecar mtimes) picks it up. */
export interface SessionState {
  pinned?: boolean;
  archived?: boolean;
}

/** Format for `exportSession`. */
export type SessionExportFormat = "markdown" | "jsonl";

/** Compress UTF-8 JSONL text with brotli (quality tuned for text). The codec
 * lives here, in the low-level persistence module, so every read/write path
 * (including sessionCompression.ts) shares one implementation. */
export function compressSessionText(text: string): Buffer {
  return brotliCompressSync(Buffer.from(text, "utf-8"), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text),
    },
  });
}

/** Decompress a brotli-compressed session buffer back to UTF-8 JSONL text. */
export function decompressSessionBuffer(buf: Buffer): string {
  return brotliDecompressSync(buf).toString("utf-8");
}

/**
 * Read a session's JSONL text whether live (`.jsonl`) or cold (`.jsonl.br`).
 * Returns "" when neither exists; never materializes plaintext for cold sessions.
 */
export async function readSessionJsonlText(id: string): Promise<string> {
  try {
    return await readFile(sessionPath(id), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "";
  }
  try {
    return decompressSessionBuffer(await readFile(compressedSessionPath(id)));
  } catch {
    return "";
  }
}

export async function readSessionSearchCorpus(id: string): Promise<string> {
  try {
    const text = await readSessionJsonlText(id);
    const lines = text.split("\n").slice(0, 200);
    const out: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Event;
        if (e.type === "message") {
          for (const b of e.content) {
            if (b.type === "text") out.push(b.text);
          }
        }
      } catch {
 /* skip */
      }
    }
    return out.join("\n");
  } catch {
    return "";
  }
}

export function renderMarkdownTranscript(events: Event[], id: string): string {
  const out: string[] = [];
  out.push(`# Session ${id}`, "");
  out.push(`Exported at ${new Date().toISOString()}`, "");
  const first = events.find((e) => e.cwd || e.gitBranch || e.version);
  if (first) {
    const bits: string[] = [];
    if (first.cwd) bits.push(`cwd: \`${first.cwd}\``);
    if (first.gitBranch) bits.push(`branch: \`${first.gitBranch}\``);
    if (first.version) bits.push(`core: ${first.version}`);
    if (bits.length) out.push(bits.join(" · "), "");
  }
  let msgIdx = 0;
  for (const e of events) {
    const when = e.ts ? ` · ${new Date(e.ts).toISOString()}` : "";
    if (e.type === "message") {
      msgIdx++;
      const speaker = e.role === "user" ? "**User**" : "**Assistant**";
      out.push(`## Turn ${msgIdx} — ${speaker}${when}`);
      if (e.model) out.push(`_model: ${e.model}_`, "");
      else out.push("");
      for (const b of e.content) {
        if (b.type === "reasoning") {
          out.push("<details><summary>Thinking</summary>", "");
          out.push(b.text.trim(), "");
          out.push("</details>", "");
        } else if (b.type === "text") {
          out.push(b.text.trim(), "");
        } else if (b.type === "tool_use") {
          out.push(`> _tool call: \`${b.name}\`_`);
          out.push("");
          out.push("```json");
          out.push(JSON.stringify(b.input ?? {}, null, 2));
          out.push("```", "");
        } else if (b.type === "tool_result") {
          out.push(`> _tool result${b.isError ? " (error)" : ""}_`);
          if (b.artifactRef) out.push(`> artifact: \`${b.artifactRef}\``);
          out.push("");
          const c = b.content.length > 1500
            ? b.content.slice(0, 1500) + `\n\n[...truncated ${b.content.length - 1500} chars]`
            : b.content;
          out.push("```");
          out.push(c);
          out.push("```", "");
        }
      }
    } else if (e.type === "tool_call") {
      out.push(`### Tool \`${e.name}\`${when}`);
      out.push("");
      out.push("```json");
      out.push(JSON.stringify(e.input ?? {}, null, 2));
      out.push("```", "");
    } else if (e.type === "tool_result") {
      out.push(`### Result \`${e.name}\`${e.isError ? " (error)" : ""}${when}`);
      out.push("");
      if (e.artifactRef) out.push(`artifact: \`${e.artifactRef}\``, "");
      const c = e.content.length > 1500
        ? e.content.slice(0, 1500) + `\n\n[...truncated ${e.content.length - 1500} chars]`
        : e.content;
      out.push("```");
      out.push(c);
      out.push("```", "");
    } else if (e.type === "request") {
      const tokens = [
        e.inputTokens !== undefined ? `in=${e.inputTokens}` : null,
        e.outputTokens !== undefined ? `out=${e.outputTokens}` : null,
        e.ttftMs !== undefined ? `ttft=${e.ttftMs}ms` : null,
        `${e.durationMs}ms`,
        e.ok ? "ok" : "fail",
      ].filter(Boolean).join(" · ");
      out.push(`_request${e.model ? ` (${e.model})` : ""}: ${tokens}_`, "");
    } else if (e.type === "plan") {
      out.push("## Plan");
      out.push("");
      for (const s of e.steps) {
        out.push(`- \`${s.status}\` **${s.id}** — ${s.title}`);
      }
      out.push("");
    } else if (e.type === "compaction") {
      out.push(`## Compaction (${e.kind ?? "summary"})`);
      out.push("");
      out.push(e.summary, "");
    } else if (e.type === "mode") {
      out.push(`_mode → ${e.mode}_`);
      out.push("");
    } else if (e.type === "error") {
      out.push(`> _error:_ ${e.message}`);
      out.push("");
    }
  }
  return out.join("\n");
}

/** Read the pin/archive sidecar. Missing/corrupt → empty state. */
export async function loadSessionState(id: string): Promise<SessionState> {
  try {
    const raw = JSON.parse(await readFile(stateSidecarPath(id), "utf-8")) as unknown;
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      return {
        pinned: o.pinned === true || undefined,
        archived: o.archived === true || undefined,
      };
    }
  } catch {
    /* missing or corrupt */
  }
  return {};
}

/** Persist the workspace cwd for a session (used by listSessions filtering). */
export async function persistSessionCwd(id: string, cwd: string): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  await writeFile(cwdSidecarPath(id), normalizeCwd(cwd), "utf-8");
}

export async function loadCwdFromDisk(id: string): Promise<string | undefined> {
  try {
    const t = await readFile(cwdSidecarPath(id), "utf-8");
    const v = t.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Delete a session's persisted file + sidecars. Refuses while a live process
 * holds the single-writer lease unless `force` is set; runs an artifact
 * mark-and-sweep for the project (pass `skipGc` to suppress). */
export async function deleteSession(
  id: string,
  opts?: { force?: boolean; skipGc?: boolean },
): Promise<void> {
  if (!opts?.force) {
    const { liveSessionLockOwner } = await import("./sessionLock.js");
    const owner = liveSessionLockOwner(id);
    if (owner) {
      throw new Error(
        `cannot delete session ${id}: owned by live pid ${owner.pid}`,
      );
    }
  }
  // Resolve the session's project BEFORE unlinking its cwd sidecar, so a
  // post-delete artifact sweep can find the right per-project store.
  const sessionCwd = await loadCwdFromDisk(id);
  const { sessionLockPath } = await import("./sessionLock.js");
  for (const p of [
    sessionPath(id),
    titleSidecarPath(id),
    cwdSidecarPath(id),
    stateSidecarPath(id),
    historyArchivePath(id),
    inboxSidecarPath(id),
    sessionLockPath(id),
  ]) {
    try {
      await unlink(p);
    } catch {
 /* ignore */
    }
  }
  // Reclaim artifacts this session referenced that no sibling session in the
  // project still points at. Fail-soft and off the critical path — a GC failure
  // never fails the delete. Skipped when the cwd is unknown (we cannot resolve
  // the project store) or when the caller opts out.
  if (!opts?.skipGc && sessionCwd) {
    try {
      const { gcProjectArtifacts } = await import("../workspace/artifactGc.js");
      await gcProjectArtifacts(sessionCwd);
    } catch {
 /* ignore — GC is best-effort */
    }
  }
}

/**
 * Export a session transcript as markdown (human-readable) or JSONL
 * (one event per line, same shape as the persisted event log).
 */
export async function exportSession(
  id: string,
  format: SessionExportFormat
): Promise<string> {
  let events: Event[] = [];
  const text = await readSessionJsonlText(id);
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
 /* skip */
    }
  }
  if (format === "jsonl") {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
  return renderMarkdownTranscript(events, id);
}