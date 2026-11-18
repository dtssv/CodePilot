import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RuleBuckets, RuleEffect } from "./permissionEngine.js";

/**
 * Persist a rule into `permissions.<effect>` in a config file. Merges with
 * existing content; creates when missing. Throws on malformed JSON.
 * @param scope "repo" (`<cwd>/.codepilot/config.json`) or "user" (`~/.codepilot/config.json`).
 */
export async function persistRule(
  cwd: string,
  rule: string,
  effect: RuleEffect = "allow",
  scope: "repo" | "user" = "repo"
): Promise<string> {
  const path =
    scope === "user"
      ? join(homedir(), ".codepilot", "config.json")
      : join(cwd, ".codepilot", "config.json");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot persist rule: ${path} is not valid JSON`);
    }
  }
  const perms = (json.permissions ?? {}) as Record<string, unknown>;
  const list = Array.isArray(perms[effect]) ? (perms[effect] as string[]) : [];
  if (!list.includes(rule)) list.push(rule);
  perms[effect] = list;
  json.permissions = perms;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(json, null, 2) + "\n", "utf-8");
  return path;
}

/** Config file path for a persisted-rule scope. */
function configPathFor(cwd: string, scope: "repo" | "user"): string {
  return scope === "user"
    ? join(homedir(), ".codepilot", "config.json")
    : join(cwd, ".codepilot", "config.json");
}

/**
 * Remove a persisted rule from `permissions.<effect>` in the scope's config
 * file. Returns true when a rule was removed, false when it was not present (or
 * the file is missing). Mirrors {@link persistRule}; throws on malformed JSON.
 */
export async function removePersistedRule(
  cwd: string,
  rule: string,
  effect: RuleEffect = "allow",
  scope: "repo" | "user" = "repo",
): Promise<boolean> {
  const path = configPathFor(cwd, scope);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot edit rules: ${path} is not valid JSON`);
  }
  const perms = (json.permissions ?? {}) as Record<string, unknown>;
  const list = Array.isArray(perms[effect]) ? (perms[effect] as string[]) : [];
  const next = list.filter((r) => r !== rule);
  if (next.length === list.length) return false;
  perms[effect] = next;
  json.permissions = perms;
  await writeFile(path, JSON.stringify(json, null, 2) + "\n", "utf-8");
  return true;
}

/** The persisted permission rules in a scope's config file (empty when the file
 * is missing). Throws on malformed JSON. */
export async function listPersistedRules(
  cwd: string,
  scope: "repo" | "user" = "repo",
): Promise<RuleBuckets> {
  const path = configPathFor(cwd, scope);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { allow: [], ask: [], deny: [] };
    }
    throw new Error(`cannot read rules: ${path} is not valid JSON`);
  }
  const perms = (json.permissions ?? {}) as Record<string, unknown>;
  const pick = (k: RuleEffect): string[] =>
    Array.isArray(perms[k]) ? (perms[k] as string[]).filter((r) => typeof r === "string") : [];
  return { allow: pick("allow"), ask: pick("ask"), deny: pick("deny") };
}