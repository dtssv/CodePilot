// Structured logger for @codepilot/core.
//
// Goals (modelled on what pino / winston do, but zero-dep):
//   - Per-namespace child loggers via `createLogger(ns)`.
//   - Output to stderr (TUI friendly, only when a sink is enabled and
//     the level passes) and to a daily-rotating NDJSON file under
//     `~/.codepilot/logs/`.
//   - File rotation: when the active file grows past 10 MB, it's
//     renamed to `<base>.1`, the previous `.1` becomes `.2`, etc. We
//     keep up to 3 generations.
//   - Levels: debug < info < warn < error. The default sink writes
//     `warn` and above to stderr (so a TUI never gets spammed), but
//     everything is also captured to the file.
//   - `CODEPILOT_LOG_LEVEL` env var overrides everything; the value
//     from `config.logging.level` wins over the env var when set.
//
// All sinks are wired through a single mutable "logger state" so that
// `initLoggerFromConfig` (or tests) can reconfigure the whole thing
// without touching call sites. The default state is lazy: nothing is
// written until either a sink is configured or someone calls
// `createLogger` (which forces the lazy state to materialise).

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  statSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogSink = (record: LogRecord) => void;

export interface LogRecord {
  /** ISO-8601 timestamp, always UTC. */
  ts: string;
  /** Numeric level for cheap filtering. */
  level: number;
  /** String form of the level (`info` / `warn` / ...). */
  levelName: LogLevel;
  /** Namespace — e.g. "agent", "session", "mcp", "tool". */
  ns: string;
  /** Free-form message. */
  msg: string;
  /** Structured key/value pairs attached to the record. */
  [extra: string]: unknown;
}

export interface Logger {
  debug(msg: string, kv?: Record<string, unknown>): void;
  info(msg: string, kv?: Record<string, unknown>): void;
  warn(msg: string, kv?: Record<string, unknown>): void;
  error(msg: string, kv?: Record<string, unknown>): void;
  /** Test / debug hook — return a snapshot of the in-memory buffer. */
  child?(suffix: string): Logger;
}

export interface LoggerConfig {
  level?: LogLevel;
  file?: string;
  console?: boolean;
  /** Override the default rotation size in bytes (default 10 MB). */
  rotateBytes?: number;
  /** Override the number of generations to keep (default 3). */
  rotateKeep?: number;
}

export interface LoggerState {
  level: LogLevel;
  consoleEnabled: boolean;
  filePath?: string;
  rotateBytes: number;
  rotateKeep: number;
  sinks: LogSink[];
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const DEFAULT_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 3;

let state: LoggerState = {
  level: readEnvLevel() ?? "info",
  consoleEnabled: true,
  rotateBytes: DEFAULT_FILE_BYTES,
  rotateKeep: DEFAULT_KEEP,
  sinks: [],
};

/** Test helper — completely reset module state. */
export function __resetLoggerForTests(): void {
  state = {
    level: readEnvLevel() ?? "info",
    consoleEnabled: true,
    rotateBytes: DEFAULT_FILE_BYTES,
    rotateKeep: DEFAULT_KEEP,
    sinks: [],
  };
}

/** Return the current logger state. Used by `loadConfigWithSources` etc. */
export function getLoggerState(): LoggerState {
  return state;
}

/** Replace the entire logger state in one shot (used by `initLoggerFromConfig`). */
export function setLoggerState(next: LoggerState): void {
  state = next;
}

/** CODEPILOT_LOG_LEVEL wins over everything except an explicit `initLoggerFromConfig`. */
function readEnvLevel(): LogLevel | undefined {
  const raw = process.env.CODEPILOT_LOG_LEVEL;
  if (!raw) return undefined;
  const lower = raw.toLowerCase() as LogLevel;
  if (lower in LOG_LEVELS) return lower;
  return undefined;
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/** Stderr sink that respects the `consoleEnabled` flag and level. */
function makeStderrSink(): LogSink {
  return (record: LogRecord) => {
    if (!state.consoleEnabled) return;
    if (record.level < LOG_LEVELS[state.level]) return;
    // TUI-friendly: one JSON object per line, on stderr.
    process.stderr.write(JSON.stringify(record) + "\n");
  };
}

/**
 * NDJSON file sink with size-based rotation. Synchronous on purpose —
 * structured logs are low volume and we never want a queued log line
 * to show up after the program has exited. (If you ever need async
 * batching, swap this out for a pino transport.)
 */
function makeFileSink(filePath: string): LogSink {
  ensureDir(filePath);
  return (record: LogRecord) => {
    // File always captures everything regardless of the active level,
    // unless the active level is higher than the record's level.
    if (record.level < LOG_LEVELS[state.level]) return;
    try {
      rotateIfNeeded(filePath, state.rotateBytes, state.rotateKeep);
      appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
    } catch (err) {
      // Never let logging crash the host program.
      try {
        process.stderr.write(
          `[logger] failed to write log: ${(err as Error).message}\n`
        );
      } catch {
        /* ignore */
      }
    }
  };
}

function ensureDir(filePath: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * If `filePath` is at or above `maxBytes`, rotate the generations:
 *   foo.log.2 → foo.log.3 (delete if it exists)
 *   foo.log.1 → foo.log.2
 *   foo.log   → foo.log.1
 * `keep` is the maximum number of `.N` files to retain. The active
 * file is recreated lazily on the next write.
 */
export function rotateIfNeeded(
  filePath: string,
  maxBytes: number,
  keep: number
): void {
  if (!existsSync(filePath)) return;
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  // Shift the oldest generation off the end.
  const oldest = `${filePath}.${keep}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      /* ignore */
    }
  }
  // Shift .(N-1) → .N, .(N-2) → .(N-1), ..., .1 → .2
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
  }
  // Active → .1
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    /* ignore */
  }
}

/** Default file path: `~/.codepilot/logs/codepilot-YYYY-MM-DD.log`. */
export function defaultLogFilePath(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return join(
    homedir(),
    ".codepilot",
    "logs",
    `codepilot-${yyyy}-${mm}-${dd}.log`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build / reset the global logger state from a `CodepilotConfig.logging`
 * block (or a raw `LoggerConfig`). Idempotent — calling it twice with
 * the same args is a no-op aside from a sink rewire.
 */
export function initLoggerFromConfig(
  config: LoggerConfig | undefined,
  options: { now?: Date } = {}
): void {
  const now = options.now ?? new Date();
  const envLevel = readEnvLevel();
  const cfgLevel = config?.level;
  const resolvedLevel: LogLevel =
    (cfgLevel && cfgLevel in LOG_LEVELS ? cfgLevel : undefined) ??
    envLevel ??
    "info";

  const consoleEnabled = config?.console !== false; // default true
  const filePath = config?.file ?? defaultLogFilePath(now);
  const rotateBytes = config?.rotateBytes ?? DEFAULT_FILE_BYTES;
  const rotateKeep = config?.rotateKeep ?? DEFAULT_KEEP;

  const sinks: LogSink[] = [makeStderrSink()];
  if (filePath) sinks.push(makeFileSink(filePath));

  setLoggerState({
    level: resolvedLevel,
    consoleEnabled,
    filePath,
    rotateBytes,
    rotateKeep,
    sinks,
  });
}

/**
 * Create a child logger for the given namespace. Cheap — just closes
 * over the namespace string and the global state.
 */
export function createLogger(ns: string): Logger {
  return {
    debug: (msg, kv) => emit("debug", ns, msg, kv),
    info: (msg, kv) => emit("info", ns, msg, kv),
    warn: (msg, kv) => emit("warn", ns, msg, kv),
    error: (msg, kv) => emit("error", ns, msg, kv),
    child: (suffix: string) => createLogger(`${ns}.${suffix}`),
  };
}

function emit(
  levelName: LogLevel,
  ns: string,
  msg: string,
  kv?: Record<string, unknown>
): void {
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level: LOG_LEVELS[levelName],
    levelName,
    ns,
    msg,
    ...(kv ?? {}),
  };
  for (const sink of state.sinks) {
    try {
      sink(record);
    } catch {
      /* never let a bad sink kill the caller */
    }
  }
}

/** Test hook: clear the active log directory. */
export function clearLogsDir(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* ignore */
    }
  }
}
