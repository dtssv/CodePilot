// Memory: read & write CODEPILOT.md (project) and ~/.codepilot/MEMORY.md (user).
// The session injects a short summary of both at start; memory_write appends.

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemorySink } from "./tools/memory_write.js";

export const PROJECT_MEMORY_NAME = "CODEPILOT.md";
export const USER_MEMORY_PATH = join(homedir(), ".codepilot", "MEMORY.md");

export interface MemoryContents {
  project?: string;
  user?: string;
}

export async function readMemory(cwd: string): Promise<MemoryContents> {
  const out: MemoryContents = {};
  try {
    out.project = await readFile(join(cwd, PROJECT_MEMORY_NAME), "utf-8");
  } catch {
    /* missing */
  }
  try {
    out.user = await readFile(USER_MEMORY_PATH, "utf-8");
  } catch {
    /* missing */
  }
  return out;
}

export class FileMemorySink implements MemorySink {
  constructor(private readonly cwd: string) {}

  async write(
    scope: "project" | "user",
    title: string,
    content: string
  ): Promise<string> {
    const path =
      scope === "project"
        ? join(this.cwd, PROJECT_MEMORY_NAME)
        : USER_MEMORY_PATH;
    let existing = "";
    try {
      existing = await readFile(path, "utf-8");
    } catch {
      /* fresh */
    }
    if (!existing.endsWith("\n") && existing.length > 0) existing += "\n";
    const stamp = new Date().toISOString().slice(0, 10);
    const block = `\n## ${title} (${stamp})\n\n${content.trim()}\n`;
    await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
    await writeFile(path, existing + block, "utf-8");
    return path;
  }
}

/** Summarise memory for system prompt injection (truncate long files). */
export function summariseMemory(
  contents: MemoryContents,
  maxChars = 4000
): MemoryContents {
  const out: MemoryContents = {};
  for (const [k, v] of Object.entries(contents) as [
    keyof MemoryContents,
    string | undefined
  ][]) {
    if (!v) continue;
    if (v.length <= maxChars) {
      out[k] = v;
    } else {
      out[k] =
        v.slice(0, maxChars) +
        `\n\n[...truncated, ${v.length - maxChars} more chars]`;
    }
  }
  return out;
}

/** True if a memory file exists. */
export async function memoryFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
