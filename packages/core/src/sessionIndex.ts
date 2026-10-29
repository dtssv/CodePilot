// SQLite-backed session metadata index (Scheme B — see
// docs/design/B-sqlite-session-index.md).
//
// Purpose: make listSessions / searchSessions O(#sessions) index lookups
// instead of re-reading + JSON-parsing every session's whole JSONL on every
// call (the hot `session/list` RPC fires on nearly every UI state change, and
// the daemon is shared across web/desktop/IDE/phone).
//
// Design invariants:
//  - JSONL is the source of truth. This DB is a *derived* index; it can be
//    deleted and rebuilt from the JSONL + sidecars at any time. The persistence
//    model (append-only event sourcing) is unchanged.
//  - Cross-process safe. The index file is shared by the daemon AND standalone
//    `codepilot sessions` CLI processes, so we open with WAL + busy_timeout and
//    wrap reconcile writes in short IMMEDIATE transactions.
//  - Fail-soft. Any open/engine error makes openSessionIndex return null; the
//    caller then uses the original full-scan path. Nothing throws to the UI.
//
// Search is metadata-only: title + cwd + the first user-message snippet. No
// full-text search over message bodies (that would be a separate FTS index).

import type Database from "better-sqlite3";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AgentMode, Event } from "./types.js";
import type { RichSessionSummary } from "./session-utils.js";
import { getSessionsDir, sameCwd } from "./session-utils.js";

function readSidecar(dir: string, id: string, ext: string): string | null {
  try {
    const v = readFileSync(join(dir, `${id}${ext}`), "utf-8").trim();
    return v || null;
  } catch {
    return null;
  }
}

const SCHEMA_VERSION = 2;

interface IndexRow {
  id: string;
  title: string;
  cwd: string;
  mode: string | null;
  model: string | null;
  message_count: number;
  first_user: string | null;
  pinned: number;
  archived: number;
  updated_at: number;
  mtime_ms: number;
  size_bytes: number;
}

export interface SessionIndex {
  list(cwd?: string): RichSessionSummary[];
  search(query: string, opts?: { cwd?: string; limit?: number }): RichSessionSummary[];
  close(): void;
}

/** Parse a session JSONL the same way extractTitleAndMeta does, plus the first
 * user snippet used for search. Mirrors session-utils semantics so index
 * results equal full-scan results. */
function parseSession(
  dir: string,
  id: string,
): {
  title: string;
  cwd: string;
  mode: string | null;
  model: string | null;
  messageCount: number;
  firstUser: string | null;
  pinned: number;
  archived: number;
} {
  let firstUserText = "";
  let mode: AgentMode | undefined;
  let model: string | undefined;
  let messageCount = 0;
  try {
    const text = readFileSync(join(dir, `${id}.jsonl`), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Event;
        if (e.type === "message") {
          if (e.role === "user" || e.role === "assistant") messageCount++;
          if (e.role === "user" && !firstUserText) {
            const first = e.content.find((b) => b.type === "text");
            if (first && first.type === "text") firstUserText = first.text;
          }
          if (e.role === "assistant" && e.model) model = e.model;
        } else if (e.type === "mode") {
          mode = e.mode;
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* unreadable → treated as untitled below */
  }
  const sidecarTitle = readSidecar(dir, id, ".title");
  const title = sidecarTitle ?? (firstUserText ? firstUserText.slice(0, 80) : "(untitled)");
  const cwd = readSidecar(dir, id, ".cwd") ?? "(unknown)";
  let pinned = 0;
  let archived = 0;
  const stateRaw = readSidecar(dir, id, ".state");
  if (stateRaw) {
    try {
      const s = JSON.parse(stateRaw) as { pinned?: unknown; archived?: unknown };
      pinned = s.pinned === true ? 1 : 0;
      archived = s.archived === true ? 1 : 0;
    } catch {
      /* corrupt state → defaults */
    }
  }
  return {
    title,
    cwd,
    mode: mode ?? null,
    model: model ?? null,
    messageCount,
    firstUser: firstUserText ? firstUserText.slice(0, 2000) : null,
    pinned,
    archived,
  };
}

function rowToSummary(r: IndexRow): RichSessionSummary {
  return {
    id: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    cwd: r.cwd,
    mode: (r.mode as AgentMode | null) ?? undefined,
    model: r.model ?? undefined,
    messageCount: r.message_count,
    pinned: r.pinned === 1 || undefined,
    archived: r.archived === 1 || undefined,
  };
}

class SqliteSessionIndex implements SessionIndex {
  private readonly upsert: Database.Statement;
  private readonly del: Database.Statement;
  private readonly selectAll: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly dir: string,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO sessions
         (id,title,cwd,mode,model,message_count,first_user,pinned,archived,updated_at,mtime_ms,size_bytes)
       VALUES (@id,@title,@cwd,@mode,@model,@message_count,@first_user,@pinned,@archived,@updated_at,@mtime_ms,@size_bytes)
       ON CONFLICT(id) DO UPDATE SET
         title=@title, cwd=@cwd, mode=@mode, model=@model, message_count=@message_count,
         first_user=@first_user, pinned=@pinned, archived=@archived,
         updated_at=@updated_at, mtime_ms=@mtime_ms, size_bytes=@size_bytes`,
    );
    this.del = db.prepare(`DELETE FROM sessions WHERE id = ?`);
    this.selectAll = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);
  }

  /** Bring the index in line with the sessions directory. Only re-parses files
   * whose mtime/size changed since they were last indexed. */
  private reconcile(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return; // dir missing — nothing to index
    }
    // `updatedAt` = the .jsonl mtime (session recency, drives list order).
    // `stamp` = max(.jsonl, .title, .cwd) mtime — the staleness key, so a
    // sidecar edit (title/cwd written after the turn) also triggers re-parse.
    const onDisk = new Map<string, { updatedAt: number; stamp: number; size: number }>();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      try {
        const st = statSync(join(this.dir, name));
        let stamp = st.mtimeMs;
        for (const ext of [".title", ".cwd", ".state"]) {
          try {
            stamp = Math.max(stamp, statSync(join(this.dir, `${id}${ext}`)).mtimeMs);
          } catch {
            /* sidecar absent */
          }
        }
        onDisk.set(id, { updatedAt: st.mtimeMs, stamp, size: st.size });
      } catch {
        /* vanished between readdir and stat */
      }
    }
    const indexed = new Map<string, { mtime_ms: number; size_bytes: number }>();
    for (const r of this.db.prepare(`SELECT id, mtime_ms, size_bytes FROM sessions`).all() as Array<{
      id: string;
      mtime_ms: number;
      size_bytes: number;
    }>) {
      indexed.set(r.id, { mtime_ms: r.mtime_ms, size_bytes: r.size_bytes });
    }

    const reconcileTxn = this.db.transaction(() => {
      // Upsert new/changed.
      for (const [id, st] of onDisk) {
        const prev = indexed.get(id);
        if (prev && prev.mtime_ms === st.stamp && prev.size_bytes === st.size) continue;
        const m = parseSession(this.dir, id);
        this.upsert.run({
          id,
          title: m.title,
          cwd: m.cwd,
          mode: m.mode,
          model: m.model,
          message_count: m.messageCount,
          first_user: m.firstUser,
          pinned: m.pinned,
          archived: m.archived,
          updated_at: st.updatedAt,
          mtime_ms: st.stamp,
          size_bytes: st.size,
        });
      }
      // Delete rows whose files are gone.
      for (const id of indexed.keys()) {
        if (!onDisk.has(id)) this.del.run(id);
      }
    });
    // IMMEDIATE so only one process reparses a batch at a time; others wait up
    // to busy_timeout then see the committed rows. If the lock can't be taken,
    // proceed with existing rows (bounded staleness, self-heals next call).
    try {
      reconcileTxn.immediate();
    } catch {
      /* SQLITE_BUSY or similar — serve stale rows this call */
    }
  }

  private rows(): RichSessionSummary[] {
    this.reconcile();
    return (this.selectAll.all() as IndexRow[])
      // Drafts (no messages yet) stay out of the sidebar, same as listSessions.
      .filter((r) => r.message_count > 0)
      .map(rowToSummary);
  }

  list(cwd?: string): RichSessionSummary[] {
    const all = this.rows();
    return cwd ? all.filter((s) => sameCwd(s.cwd, cwd)) : all;
  }

  search(query: string, opts: { cwd?: string; limit?: number } = {}): RichSessionSummary[] {
    this.reconcile();
    const q = query.trim().toLowerCase();
    const base = opts.cwd
      ? (this.selectAll.all() as IndexRow[]).filter((r) => sameCwd(r.cwd, opts.cwd))
      : (this.selectAll.all() as IndexRow[]);
    const live = base.filter((r) => r.message_count > 0);
    if (!q) {
      const out = live.map(rowToSummary);
      return opts.limit ? out.slice(0, opts.limit) : out;
    }
    const scored: Array<{ r: IndexRow; score: number }> = [];
    for (const r of live) {
      if (r.title.toLowerCase().includes(q)) scored.push({ r, score: 100 });
      else if (
        r.cwd.toLowerCase().includes(q) ||
        (r.first_user ? r.first_user.toLowerCase().includes(q) : false)
      ) {
        scored.push({ r, score: 1 });
      }
    }
    // Stable order across platforms: score, then recency, then id as a final
    // deterministic tie-break. Without the id key, two rows with the same score
    // and the same mtime (common on filesystems with coarse mtime granularity,
    // e.g. some Linux CI runners) would sort nondeterministically.
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.r.updated_at - a.r.updated_at ||
        (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0),
    );
    const out = scored.map((s) => rowToSummary(s.r));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Open (or create) the shared session index. Returns null on any failure so
 * the caller falls back to the full-scan implementation. `dir` defaults to the
 * sessions directory; tests pass a temp dir. */
export function openSessionIndex(dir?: string): SessionIndex | null {
  const sessionsDir = dir ?? getSessionsDir();
  try {
    // Lazy require so a missing/unbuildable native addon degrades to the
    // full-scan path instead of crashing the whole module graph.
    const req = createRequire(import.meta.url);
    const DatabaseCtor = req("better-sqlite3") as typeof Database;
    const db = new DatabaseCtor(join(sessionsDir, "index.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");
    const version = (db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (version !== SCHEMA_VERSION) {
      // Derived index — safe to drop and rebuild on a schema change.
      db.exec(`DROP TABLE IF EXISTS sessions`);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL DEFAULT '(untitled)',
        cwd           TEXT NOT NULL DEFAULT '(unknown)',
        mode          TEXT,
        model         TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        first_user    TEXT,
        pinned        INTEGER NOT NULL DEFAULT 0,
        archived      INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        size_bytes    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(cwd);
    `);
    return new SqliteSessionIndex(db, sessionsDir);
  } catch {
    return null;
  }
}
