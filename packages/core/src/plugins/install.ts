import { readFile, rm, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pluginContentHash, PluginTrustStore } from "./plugins-trust.js";
import { describePluginCapabilities } from "./capabilities.js";
import type { InstallOptions, PluginCapabilityReport, PluginManifest } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Install a plugin from a git URL (cloned) or local path (copied). A `#subdir`
 * fragment selects a monorepo sub-directory. Returns the installed path.
 * Throws if it exists (unless `force`) or has no `plugin.json`.
 */
export async function installPlugin(
  source: string,
  opts: InstallOptions = {}
): Promise<string> {
  const name = derivePluginName(source);
  const target = opts.installDir ?? join(homedir(), ".codepilot", "plugins", name);
  if (existsSync(target)) {
    if (!opts.force) {
      throw new Error(`plugin ${name} already installed at ${target} (use force: true to overwrite)`);
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(join(homedir(), ".codepilot", "plugins"), { recursive: true });

  await fetchPluginInto(source, target);

 // Verify the manifest exists.
  const manifestPath = join(target, "plugin.json");
  if (!existsSync(manifestPath)) {
    await rm(target, { recursive: true, force: true });
    throw new Error(`installed source has no plugin.json — not a valid plugin`);
  }
 // Record the sensitive-content fingerprint at install-consent time. Reaching
 // here means the caller consented (after inspectPluginSource). A later on-disk
 // change to the plugin's hooks / MCP servers / runtime will no longer match
 // this hash, and mergePluginConfig skips those components until the user
 // re-confirms. Best-effort: a trust-file write failure must not fail install.
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
    const store = opts.trustStore ?? new PluginTrustStore();
    await store.record(manifest.name, pluginContentHash(manifest));
  } catch {
 /* non-fatal: content trust is defence-in-depth, not install-critical */
  }
  return target;
}

/**
 * Fetch a plugin source (git URL or local path, honouring a `#subdir`
 * monorepo fragment) into `target`. Shared by {@link installPlugin} and
 * {@link inspectPluginSource}. Does not verify the manifest — the caller does.
 */
async function fetchPluginInto(source: string, target: string): Promise<void> {
  // Split off an optional `#subdir` monorepo fragment.
  const hash = source.indexOf("#");
  const bare = hash >= 0 ? source.slice(0, hash) : source;
  const subdir = hash >= 0 ? source.slice(hash + 1).replace(/^\/+|\/+$/g, "") : "";

  if (bare.startsWith("http://") || bare.startsWith("https://") || bare.startsWith("git@")) {
    if (subdir) {
      // Clone the whole repo to a temp dir, then copy only the sub-directory.
      const tmp = await mkdtemp(join(tmpdir(), "codepilot-plugin-"));
      try {
        await execFileAsync("git", ["clone", "--depth", "1", bare, tmp]);
        const picked = join(tmp, subdir);
        if (!existsSync(picked)) {
          throw new Error(`sub-directory not found in repo: ${subdir}`);
        }
        await mkdir(target, { recursive: true });
        await execFileAsync("cp", ["-R", `${picked}/.`, target]);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    } else {
      const { stdout, stderr } = await execFileAsync("git", ["clone", "--depth", "1", bare, target]);
      if (stderr && !stdout) {
        // git writes progress to stderr; only throw on actual errors
      }
    }
  } else {
    // Local directory copy (honours a `#subdir` fragment too).
    const root = isAbsolute(bare) ? bare : resolve(process.cwd(), bare);
    const src = subdir ? join(root, subdir) : root;
    if (!existsSync(src)) throw new Error(`source not found: ${src}`);
    await mkdir(target, { recursive: true });
    const { stdout } = await execFileAsync("cp", ["-R", `${src}/.`, target]);
    void stdout;
  }
}

/**
 * Inspect what a plugin source will do, without installing it. Fetches into a
 * temp dir, builds a {@link PluginCapabilityReport}, then discards the copy.
 * Throws if the source has no valid `plugin.json`.
 */
export async function inspectPluginSource(source: string): Promise<PluginCapabilityReport> {
  const tmp = await mkdtemp(join(tmpdir(), "codepilot-plugin-inspect-"));
  try {
    await fetchPluginInto(source, tmp);
    const manifestPath = join(tmp, "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`source has no plugin.json — not a valid plugin`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
    if (!manifest?.name || !manifest?.description || !manifest?.version) {
      throw new Error(`plugin.json is missing required name/description/version`);
    }
    return await describePluginCapabilities(manifest, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Uninstall a plugin by name. Removes the plugin directory from
 * `~/.codepilot/plugins/<name>/`. Returns true if the plugin was found
 * and removed.
 */
export async function uninstallPlugin(name: string): Promise<boolean> {
  const target = join(homedir(), ".codepilot", "plugins", name);
  if (!existsSync(target)) return false;
  await rm(target, { recursive: true, force: true });
  // Drop the recorded content fingerprint so a future re-install re-approves
  // from scratch rather than matching a stale hash. Best-effort.
  try {
    await new PluginTrustStore().forget(name);
  } catch {
    /* non-fatal */
  }
  return true;
}

/** Derive a plugin name from a source URL or path. */
export function derivePluginName(source: string): string {
 // For git URLs: use the repo name (last path segment, minus .git).
 // For local paths: use the directory name.
 // A `#subdir` fragment (monorepo sub-path) names the plugin after the
 // sub-directory, not the repo — e.g. `.../plugins.git#code-review` → `code-review`.
  const hash = source.indexOf("#");
  if (hash >= 0) {
    const sub = source.slice(hash + 1).replace(/\/$/, "");
    const segs = sub.split("/").filter(Boolean);
    if (segs.length > 0) return segs[segs.length - 1]!;
  }
  const clean = source.slice(0, hash >= 0 ? hash : undefined).replace(/\.git$/, "").replace(/\/$/, "");
  const segments = clean.split(/[\/:]/);
  return segments[segments.length - 1] ?? "unknown-plugin";
}