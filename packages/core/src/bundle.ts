// Bundle export / import (#28).
//
// A "bundle" is a single self-contained JSON file that captures everything
// a user needs to reproduce their CodePilot setup on another machine:
//
//   {
//     "version": 1,
//     "config":   { ...resolved CodepilotConfig... },
//     "commands": { "review.md":  "<markdown content>" },
//     "agents":   { "explore.md": "<markdown content>" },
//     "skills":   { "pdf/SKILL.md": "<markdown content>" }
//   }
//
// - `exportBundle` resolves the layered config for a cwd and snapshots the
//   user-level (~/.codepilot) and project-level (<cwd>/.codepilot) custom
//   commands, agents and skills into the bundle.
// - `importBundle` does the reverse: it writes the bundle's config to
//   `~/.codepilot/config.json` and materialises the resources under
//   `~/.codepilot/commands`, `~/.codepilot/agents` and `~/.codepilot/skills`.
//
// Resource keys are relative file names; `skills` entries may include one
// path segment (`<name>/SKILL.md`). Keys are validated on import to prevent
// path traversal outside the target directories.

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, normalize, sep } from "node:path";
import { homedir } from "node:os";
import type { ResolvedCodepilotConfig } from "./config.js";
import { loadConfigWithSources, getUserConfigPath } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const BUNDLE_VERSION = 1;

export interface CodepilotBundle {
  version: number;
  config: Record<string, unknown>;
  /** command file name (e.g. "review.md") -> markdown content. */
  commands: Record<string, string>;
  /** agent file name (e.g. "explore.md") -> markdown content. */
  agents: Record<string, string>;
  /** skill path (e.g. "pdf/SKILL.md") -> markdown content. */
  skills: Record<string, string>;
}

export interface ExportBundleOptions {
  /** Resolve config as if running in this directory (defaults to process.cwd()). */
  cwd?: string;
  /** Also include project-level (<cwd>/.codepilot) resources.
   *  Default true. Project entries overwrite user entries with the same name. */
  includeProject?: boolean;
  /** Activate this profile before exporting (same as --profile). */
  profile?: string;
  /** Apply this JSON merge-patch before exporting (same as --config-patch). */
  patch?: Record<string, unknown>;
  /** Home directory override (defaults to os.homedir()). Useful for tests. */
  homeDir?: string;
}

export interface ImportBundleOptions {
  /** Home directory override (defaults to os.homedir()). Useful for tests. */
  homeDir?: string;
}

export interface ImportBundleResult {
  /** Absolute path the config was written to. */
  configPath: string;
  /** Number of files written per resource kind. */
  commands: number;
  agents: number;
  skills: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Build a bundle from the current machine: resolved config + user/project
 * commands, agents and skills.
 */
export async function exportBundle(
  options: ExportBundleOptions = {}
): Promise<CodepilotBundle> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const includeProject = options.includeProject !== false;

  const { config } = await loadConfigWithSources(cwd, undefined, {
    profile: options.profile,
    patch: options.patch,
    homeDir: options.homeDir,
  });

  // Strip undefined values so the bundle is clean JSON.
  const configJson = JSON.parse(
    JSON.stringify(config)
  ) as Record<string, unknown>;

  const bundle: CodepilotBundle = {
    version: BUNDLE_VERSION,
    config: configJson,
    commands: {},
    agents: {},
    skills: {},
  };

  // User-level first (lower priority), then project-level overwrites.
  const sources: Array<{ dir: string; kind: "commands" | "agents" | "skills" }> = [
    { dir: join(home, ".codepilot", "commands"), kind: "commands" },
    { dir: join(home, ".codepilot", "agents"), kind: "agents" },
    { dir: join(home, ".codepilot", "skills"), kind: "skills" },
  ];
  if (includeProject) {
    sources.push(
      { dir: join(cwd, ".codepilot", "commands"), kind: "commands" },
      { dir: join(cwd, ".codepilot", "agents"), kind: "agents" },
      { dir: join(cwd, ".codepilot", "skills"), kind: "skills" }
    );
  }

  for (const { dir, kind } of sources) {
    const files = await collectResourceFiles(dir, kind === "skills");
    for (const [rel, content] of files) {
      bundle[kind][rel] = content;
    }
  }

  return bundle;
}

/** Serialize a bundle to pretty-printed JSON. */
export function serializeBundle(bundle: CodepilotBundle): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

/**
 * Export a bundle and write it to disk. Returns the bundle.
 * Parent directories of `path` are created as needed.
 */
export async function exportBundleToFile(
  path: string,
  options: ExportBundleOptions = {}
): Promise<CodepilotBundle> {
  const bundle = await exportBundle(options);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeBundle(bundle), "utf-8");
  return bundle;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Parse and validate a bundle from a JSON string. */
export function parseBundle(json: string): CodepilotBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Invalid bundle: not valid JSON (${(err as Error).message})`
    );
  }
  return validateBundle(raw);
}

export function validateBundle(raw: unknown): CodepilotBundle {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid bundle: expected a JSON object at the top level");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== BUNDLE_VERSION) {
    throw new Error(
      `Invalid bundle: unsupported version ${JSON.stringify(obj.version)} ` +
        `(this build supports version ${BUNDLE_VERSION})`
    );
  }
  if (typeof obj.config !== "object" || obj.config === null || Array.isArray(obj.config)) {
    throw new Error('Invalid bundle: "config" must be an object');
  }
  const out: CodepilotBundle = {
    version: BUNDLE_VERSION,
    config: obj.config as Record<string, unknown>,
    commands: readResourceMap(obj.commands, "commands"),
    agents: readResourceMap(obj.agents, "agents"),
    skills: readResourceMap(obj.skills, "skills"),
  };
  return out;
}

/**
 * Import a bundle: writes `config` to `~/.codepilot/config.json` and the
 * resource files under `~/.codepilot/commands|agents|skills`.
 */
export async function importBundle(
  bundle: CodepilotBundle,
  options: ImportBundleOptions = {}
): Promise<ImportBundleResult> {
  const home = options.homeDir ?? homedir();
  const root = join(home, ".codepilot");

  const configPath = getUserConfigPathFor(home);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify(bundle.config, null, 2) + "\n",
    "utf-8"
  );

  const written = { commands: 0, agents: 0, skills: 0 };
  for (const kind of ["commands", "agents", "skills"] as const) {
    const dir = join(root, kind);
    for (const [rel, content] of Object.entries(bundle[kind])) {
      const target = safeJoin(dir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
      written[kind]++;
    }
  }

  return { configPath, ...written };
}

/** Read a bundle file from disk and import it. */
export async function importBundleFromFile(
  path: string,
  options: ImportBundleOptions = {}
): Promise<ImportBundleResult> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read bundle ${path}: ${(err as Error).message}`
    );
  }
  return importBundle(parseBundle(text), options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** getUserConfigPath, but against an explicit home dir (testability). */
function getUserConfigPathFor(home: string): string {
  if (home === homedir()) return getUserConfigPath();
  return join(home, ".codepilot", "config.json");
}

/**
 * Collect resource files under `dir`. When `nested` is true (skills), one
 * level of subdirectories is scanned and keys are `<subdir>/<file>`.
 * Returns entries as [relativeName, content] pairs, sorted for determinism.
 */
async function collectResourceFiles(
  dir: string,
  nested: boolean
): Promise<Array<[string, string]>> {
  if (!existsSync(dir)) return [];
  const out: Array<[string, string]> = [];

  const readDir = async (d: string): Promise<string[]> => {
    try {
      return await readdir(d);
    } catch {
      return [];
    }
  };

  for (const entry of await readDir(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isFile() && entry.endsWith(".md")) {
      out.push([entry, await readFile(full, "utf-8")]);
    } else if (nested && st.isDirectory()) {
      for (const sub of await readDir(full)) {
        const subFull = join(full, sub);
        try {
          const subSt = await stat(subFull);
          if (!subSt.isFile()) continue;
        } catch {
          continue;
        }
        if (!sub.endsWith(".md")) continue;
        out.push([`${entry}/${sub}`, await readFile(subFull, "utf-8")]);
      }
    }
  }

  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

function readResourceMap(
  raw: unknown,
  kind: string
): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Invalid bundle: "${kind}" must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(
        `Invalid bundle: "${kind}.${k}" must be a string (file content)`
      );
    }
    // Validate the key eagerly so importBundle never sees a bad name.
    assertSafeResourceName(k);
    out[k] = v;
  }
  return out;
}

/**
 * Reject resource names that could escape the target directory
 * (absolute paths, `..` segments, backslashes on Windows).
 */
function assertSafeResourceName(name: string): void {
  const normalised = normalize(name);
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    normalised === ".." ||
    normalised.startsWith(`..${sep}`) ||
    normalised.startsWith("../")
  ) {
    throw new Error(
      `Invalid bundle: unsafe resource name ${JSON.stringify(name)}`
    );
  }
}

/** Join `rel` onto `dir`, refusing paths that escape `dir`. */
function safeJoin(dir: string, rel: string): string {
  assertSafeResourceName(rel);
  const target = normalize(join(dir, rel));
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new Error(
      `Invalid bundle: resource name escapes target directory: ${JSON.stringify(rel)}`
    );
  }
  return target;
}
