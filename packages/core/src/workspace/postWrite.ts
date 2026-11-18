// Post-write step shared by the file-writing tools (write_file, edit_file,
// apply_patch): run the configured formatters on each touched file, then
// report language-server errors that appeared since the model last saw that
// file's errors. Everything here is best-effort — a formatter or language
// server failure never fails the edit; it only shapes the note appended to
// the tool result.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, relative } from "node:path";
import { hashFileContent } from "./fsObservation.js";
import { lspPath } from "./lsp.js";
import { shellQuote, wrapCommand } from "../sandbox/sandbox.js";
import type { Diagnostic } from "../tools/diagnostics.js";
import type { ToolContext } from "../tools/types.js";

export interface FormatterEntry {
  /** argv; `$FILE` is replaced with the absolute path of the written file.
   * The project's `node_modules/.bin` is on PATH. */
  command: string[];
  /** Extensions this formatter handles, with the dot (e.g. ".ts"). */
  extensions: string[];
  disabled?: boolean;
  environment?: Record<string, string>;
}

export interface PostWriteOptions {
  formatters?: Record<string, FormatterEntry>;
  /** Fresh diagnostics for `absPath` after a write; null when unavailable. */
  diagnostics?: (absPath: string, cwd: string) => Promise<Diagnostic[] | null>;
}

/** Returns a note to append to the tool result ("" when there is nothing to say). */
export type PostWrite = (absPaths: string[], ctx: ToolContext) => Promise<string>;

const FORMATTER_TIMEOUT_MS = 30_000;
/** Files checked per write; a large apply_patch reports on the first few. */
const MAX_DIAGNOSTIC_FILES = 5;
const MAX_ERRORS_PER_FILE = 20;

const errorKey = (d: Diagnostic): string => `${d.source ?? ""}|${d.code ?? ""}|${d.message}`;

function runFormatter(entry: FormatterEntry, file: string, ctx: ToolContext): Promise<string | null> {
  const argv = entry.command.map((a) => a.split("$FILE").join(file));
  let bin = argv[0]!;
  let args = argv.slice(1);
  if (ctx.sandbox && process.platform !== "win32") {
    const wrapped = wrapCommand(argv.map(shellQuote).join(" "), ctx.sandbox);
    if (wrapped.sandboxed) {
      bin = wrapped.shell ?? "/bin/sh";
      args = [...(wrapped.shellArgs ?? ["-c"]), wrapped.command];
    }
  }
  return new Promise((resolveRun) => {
    execFile(
      bin,
      args,
      {
        cwd: ctx.cwd,
        env: { ...process.env, PATH: lspPath(ctx.cwd), ...entry.environment },
        timeout: FORMATTER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32",
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      (err, _stdout, stderr) => {
        if (!err) return resolveRun(null);
        const detail = String(stderr || err.message).trim().split("\n")[0] ?? "";
        resolveRun(detail.slice(0, 200) || "failed");
      },
    );
  });
}

export function createPostWrite(opts: PostWriteOptions): PostWrite {
  const formatters = Object.entries(opts.formatters ?? {}).filter(
    ([, f]) => !f.disabled && f.command.length > 0,
  );
  // file → error keys last shown to the model, so unchanged pre-existing errors
  // aren't repeated after every edit. Replaced (not merged) on each check, so a
  // fixed-then-reintroduced error is reported again.
  const reported = new Map<string, Set<string>>();

  const format = async (files: string[], ctx: ToolContext): Promise<string[]> => {
    const notes: string[] = [];
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      const matching = formatters.filter(([, f]) => f.extensions.some((e) => e.toLowerCase() === ext));
      if (matching.length === 0) continue;
      const before = await readFile(file).catch(() => null);
      if (before === null) continue;
      const ran: string[] = [];
      for (const [name, entry] of matching) {
        if (ctx.signal?.aborted) return notes;
        const failure = await runFormatter(entry, file, ctx);
        if (failure) notes.push(`formatter ${name} failed on ${relative(ctx.cwd, file)}: ${failure}`);
        else ran.push(name);
      }
      const after = await readFile(file).catch(() => null);
      if (after === null || after.equals(before)) continue;
      try {
        const s = await stat(file);
        ctx.reobserveFile?.(file, { mtimeMs: s.mtimeMs, size: s.size }, hashFileContent(after));
      } catch {
        /* best-effort */
      }
      notes.push(
        `${relative(ctx.cwd, file)} was reformatted by ${ran.join(", ")}; ` +
          `re-read it before editing text you have not seen since.`,
      );
    }
    return notes;
  };

  const check = async (files: string[], ctx: ToolContext): Promise<string[]> => {
    const getDiagnostics = opts.diagnostics;
    if (!getDiagnostics) return [];
    const results = await Promise.all(
      files.slice(0, MAX_DIAGNOSTIC_FILES).map(async (file) => ({
        file,
        diags: await getDiagnostics(file, ctx.cwd).catch(() => null),
      })),
    );
    const out: string[] = [];
    for (const { file, diags } of results) {
      if (diags === null) continue;
      const errors = diags.filter((d) => d.severity === "error");
      const seen = reported.get(file) ?? new Set<string>();
      const fresh = errors.filter((d) => !seen.has(errorKey(d)));
      reported.set(file, new Set(errors.map(errorKey)));
      const rel = relative(ctx.cwd, file) || file;
      const remaining = errors.length - fresh.length;
      if (fresh.length === 0) {
        if (remaining > 0) out.push(`${rel}: ${remaining} previously reported error(s) still present`);
        continue;
      }
      fresh.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
      for (const d of fresh.slice(0, MAX_ERRORS_PER_FILE)) {
        const src = d.source ? ` [${d.source}${d.code !== undefined ? ":" + d.code : ""}]` : "";
        out.push(`${rel}:${d.line}${d.column ? ":" + d.column : ""} error${src} ${d.message}`);
      }
      if (fresh.length > MAX_ERRORS_PER_FILE) {
        out.push(`${rel}: …and ${fresh.length - MAX_ERRORS_PER_FILE} more new error(s)`);
      }
      if (remaining > 0) out.push(`${rel}: plus ${remaining} previously reported error(s) still present`);
    }
    return out;
  };

  return async (absPaths, ctx) => {
    try {
      const files = [...new Set(absPaths)].filter((p) => existsSync(p));
      if (files.length === 0 || ctx.signal?.aborted) return "";
      const formatNotes = formatters.length > 0 ? await format(files, ctx) : [];
      const errorLines = ctx.signal?.aborted ? [] : await check(files, ctx);
      let note = "";
      if (formatNotes.length > 0) note += `\n${formatNotes.join("\n")}`;
      if (errorLines.length > 0) note += `\nLanguage-server errors after this write:\n${errorLines.join("\n")}`;
      return note;
    } catch {
      return "";
    }
  };
}
