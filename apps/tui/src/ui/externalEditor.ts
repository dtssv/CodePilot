/**
 * Compose a prompt in the user's editor ($VISUAL / $EDITOR): write the draft
 * to a temp file, hand the terminal to the editor, read the result back.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The editor command line, or the platform default. */
export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (configured) return configured;
  return process.platform === "win32" ? "notepad" : "vi";
}

export type EditorResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Open `draft` in the editor and wait for it to exit. Blocks the event loop
 * on purpose: the editor owns the TTY until it exits. The caller must leave
 * raw mode first and restore it after.
 */
export function editInExternalEditor(draft: string, env: NodeJS.ProcessEnv = process.env): EditorResult {
  const dir = mkdtempSync(join(tmpdir(), "codepilot-prompt-"));
  const file = join(dir, "PROMPT.md");
  try {
    writeFileSync(file, draft, "utf-8");
    const editor = resolveEditor(env);
    // The editor setting may carry flags (`code --wait`), so run it via the shell.
    const quoted = process.platform === "win32" ? `"${file}"` : `'${file.replace(/'/g, `'\\''`)}'`;
    const r = spawnSync(`${editor} ${quoted}`, { stdio: "inherit", shell: true, env });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: `${editor} exited with status ${r.status ?? r.signal}` };
    return { ok: true, text: readFileSync(file, "utf-8").replace(/\r?\n$/, "") };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
