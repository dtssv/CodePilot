/**
 * While the Ink UI owns the terminal, anything written straight to stderr
 * (provider retry notes, library warnings, MCP auth URLs) lands in the middle
 * of the frame and breaks Ink's line bookkeeping. `installStderrCapture`
 * diverts those writes: each chunk is appended to a log file and handed to
 * the UI, which shows it as a notice.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Listener = (text: string) => void;

const listeners = new Set<Listener>();
const backlog: string[] = [];

export function defaultStderrLogPath(home: string = homedir()): string {
  return join(home, ".codepilot", "logs", "tui-stderr.log");
}

/** Subscribe to captured stderr text. Delivers anything captured before the
 * first subscriber attached. */
export function onCapturedStderr(listener: Listener): () => void {
  listeners.add(listener);
  for (const text of backlog.splice(0)) listener(text);
  return () => {
    listeners.delete(listener);
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function installStderrCapture(logFile: string = defaultStderrLogPath()): () => void {
  const original = process.stderr.write.bind(process.stderr);
  let logReady = false;
  const capture = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf-8")
          : String(chunk);
    try {
      if (!logReady) {
        mkdirSync(dirname(logFile), { recursive: true });
        logReady = true;
      }
      appendFileSync(logFile, `[${new Date().toISOString()}] ${text}${text.endsWith("\n") ? "" : "\n"}`);
    } catch {
      /* logging is best-effort */
    }
    const shown = text.replace(ANSI, "").trim();
    if (shown) {
      if (listeners.size === 0) backlog.push(shown);
      else for (const l of listeners) l(shown);
    }
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  process.stderr.write = capture as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
}
