// Config loading. Repo-level .codepilot/config.json takes priority over the
// user-level ~/.codepilot/config.json. Missing files are simply ignored.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CodepilotConfig } from "./types.js";

const USER_CONFIG = join(homedir(), ".codepilot", "config.json");
const REPO_CONFIG = ".codepilot/config.json";

export async function loadConfig(cwd: string): Promise<CodepilotConfig> {
  const [user, repo] = await Promise.all([
    readJsonIfExists(USER_CONFIG),
    readJsonIfExists(join(cwd, REPO_CONFIG)),
  ]);
  return mergeConfig(user, repo);
}

export function mergeConfig(
  base: Partial<CodepilotConfig> | undefined,
  override: Partial<CodepilotConfig> | undefined
): CodepilotConfig {
  if (!base) return (override ?? {}) as CodepilotConfig;
  if (!override) return base as CodepilotConfig;
  const out: CodepilotConfig = { ...base, ...override };
  if (base.autoApprove || override.autoApprove) {
    out.autoApprove = [
      ...(base.autoApprove ?? []),
      ...(override.autoApprove ?? []),
    ];
  }
  if (base.mcpServers || override.mcpServers) {
    out.mcpServers = { ...(base.mcpServers ?? {}), ...(override.mcpServers ?? {}) };
  }
  return out;
}

async function readJsonIfExists(
  path: string
): Promise<Partial<CodepilotConfig> | undefined> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as Partial<CodepilotConfig>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // Malformed JSON is a real problem — surface it.
    throw new Error(`Failed to parse config ${path}: ${(err as Error).message}`);
  }
}
