// Materialise browser-uploaded files into the workspace so the model can
// read them with the normal file tools. Images still travel as vision
// blocks separately; this path is for everything else (and also works for
// images the user wants on disk).

import { mkdir, writeFile, access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PromptFile, SavedUpload } from "./types.js";

export type { PromptFile, SavedUpload };

export const UPLOAD_DIR = ".codepilot/uploads";
/** Match read_image's raw-byte cap so a dropped PDF / zip stays usable. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function materializeUploads(
  cwd: string,
  files: PromptFile[],
): Promise<SavedUpload[]> {
  if (files.length === 0) return [];
  const dir = join(cwd, UPLOAD_DIR);
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
    const path = await uniqueRelPath(dir, safe);
    await writeFile(join(cwd, path), buf);
    out.push({
      name: f.name || safe,
      path,
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
    "Attached files (saved in the workspace — use `read_file` / `bash` / `read_image` as needed):\n" +
    lines.join("\n")
  );
}

function safeBasename(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/^\.+/, "");
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").trim() || "upload";
  return cleaned.slice(0, 180);
}

async function uniqueRelPath(absDir: string, safe: string): Promise<string> {
  let candidate = join(UPLOAD_DIR, safe);
  let abs = join(absDir, safe);
  if (!(await exists(abs))) return candidate;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const name = `${stem}-${i}${ext}`;
    candidate = join(UPLOAD_DIR, name);
    abs = join(absDir, name);
    if (!(await exists(abs))) return candidate;
  }
  return join(UPLOAD_DIR, `${stem}-${Date.now()}${ext}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
