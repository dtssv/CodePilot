// Materialise browser-uploaded files into project state so the model can
// read them with the normal file tools. Images still travel as vision
// blocks separately; this path is for everything else (and also works for
// images the user wants on disk).
//
// Files land under `~/.codepilot/projects/<hash>/uploads/` (not the
// workspace) so uploads never pollute the git tree.

import { mkdir, writeFile, access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PromptFile, SavedUpload } from "./types.js";
import { ensureProjectState, projectStatePath } from "./projectState.js";

export type { PromptFile, SavedUpload };

/** Absolute uploads directory for a workspace (under home project state). */
export function uploadsDir(cwd: string): string {
  return projectStatePath(cwd, "uploads");
}

/** @deprecated Prefer {@link uploadsDir}; kept for callers that expect a relative hint. */
export const UPLOAD_DIR = ".codepilot/uploads";

/** Match read_image's raw-byte cap so a dropped PDF / zip stays usable. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function materializeUploads(
  cwd: string,
  files: PromptFile[],
): Promise<SavedUpload[]> {
  if (files.length === 0) return [];
  await ensureProjectState(cwd);
  const dir = uploadsDir(cwd);
  await mkdir(dir, { recursive: true });
  const out: SavedUpload[] = [];
  for (const f of files) {
    const buf = Buffer.from(f.base64, "base64");
    if (buf.length === 0) {
      throw new Error(`${f.name || "file"}: empty`);
    }
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `${f.name || "file"}: ${buf.length.toLocaleString()} bytes exceeds the ${MAX_UPLOAD_BYTES.toLocaleString()}-byte upload limit`,
      );
    }
    const safe = safeBasename(f.name);
    const abs = await uniqueAbsPath(dir, safe);
    await writeFile(abs, buf);
    out.push({
      name: f.name || safe,
      path: abs,
      mediaType: f.mediaType,
      bytes: buf.length,
    });
  }
  return out;
}

export function formatUploadNote(files: SavedUpload[]): string {
  if (files.length === 0) return "";
  const lines = files.map(
    (f) =>
      `- \`${f.path}\` (${f.mediaType || "file"}, ${f.bytes.toLocaleString()} bytes)`,
  );
  return (
    "Attached files (saved under `~/.codepilot/projects/…/uploads/` — use `read_file` / `bash` / `read_image` as needed):\n" +
    lines.join("\n")
  );
}

function safeBasename(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/^\.+/, "");
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").trim() || "upload";
  return cleaned.slice(0, 180);
}

async function uniqueAbsPath(absDir: string, safe: string): Promise<string> {
  let abs = join(absDir, safe);
  if (!(await exists(abs))) return abs;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    abs = join(absDir, `${stem}-${i}${ext}`);
    if (!(await exists(abs))) return abs;
  }
  return join(absDir, `${stem}-${Date.now()}${ext}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
