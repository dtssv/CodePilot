import { readFile, writeFile, rm, mkdir, mkdtemp, cp, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pluginContentHash, PluginTrustStore } from "./plugins-trust.js";
import { describePluginCapabilities } from "./capabilities.js";
import type { InstallOptions, PluginCapabilityReport, PluginManifest } from "./types.js";

const execFileAsync = promisify(execFile);

/** Sidecar written next to plugin.json at install time. */
export interface PluginInstallMeta {
  source: string;
  commit?: string;
  installedAt: string;
}

/**
 * Install a plugin from a git URL (cloned) or local path (copied). A `#subdir`
 * fragment selects a monorepo sub-directory. Returns the installed path.
 * Throws if it exists (unless `force`) or has no `plugin.json`.
 *
 * Requires `opts.consent === true` so hosts cannot silently write a trust hash
 * without an explicit install confirmation.
 */
export async function installPlugin(
  source: string,
  opts: InstallOptions = {}
): Promise<string> {
  if (opts.consent !== true) {
    throw new Error(
      "installPlugin requires consent: true (confirm after inspectPluginSource)",
    );
  }
  const name = derivePluginName(source);
  const target = opts.installDir ?? join(homedir(), ".codepilot", "plugins", name);
  if (existsSync(target)) {
    if (!opts.force) {
      throw new Error(`plugin ${name} already installed at ${target} (use force: true to overwrite)`);
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(join(homedir(), ".codepilot", "plugins"), { recursive: true });

  let commit: string | undefined;
  try {
    commit = await fetchPluginInto(source, target);
  } catch (err) {
    // Never leave a half-written install directory.
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

 // Verify the manifest exists.
  const manifestPath = join(target, "plugin.json");
  if (!existsSync(manifestPath)) {
    await rm(target, { recursive: true, force: true });
    throw new Error(`installed source has no plugin.json — not a valid plugin`);
  }

  // Install origin metadata (best-effort).
  try {
    const meta: PluginInstallMeta = {
      source,
      installedAt: new Date().toISOString(),
      ...(commit ? { commit } : {}),
    };
    await writeFile(join(target, ".install.json"), JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }

 // Record the sensitive-content fingerprint at install-consent time.
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
    const store = opts.trustStore ?? new PluginTrustStore();
    await store.record(manifest.name, pluginContentHash(manifest, target));
  } catch {
 /* non-fatal: content trust is defence-in-depth, not install-critical */
  }
  return target;
}

/**
 * Fetch a plugin source (git URL or local path, honouring a `#subdir`
 * monorepo fragment) into `target`. Returns a git commit SHA when available.
 * Shared by {@link installPlugin} and {@link inspectPluginSource}.
 */
async function fetchPluginInto(source: string, target: string): Promise<string | undefined> {
  // Split off an optional `#subdir` monorepo fragment.
  const hash = source.indexOf("#");
  const bare = hash >= 0 ? source.slice(0, hash) : source;
  const subdir = hash >= 0 ? source.slice(hash + 1).replace(/^\/+|\/+$/g, "") : "";

  if (bare.startsWith("http://") || bare.startsWith("https://") || bare.startsWith("git@")) {
    // Always clone to tmp then promote — never leave a partial `target` on failure.
    const tmp = await mkdtemp(join(tmpdir(), "codepilot-plugin-"));
    try {
      await execFileAsync("git", ["clone", "--depth", "1", bare, tmp]);
      let commit: string | undefined;
      try {
        const { stdout } = await execFileAsync("git", ["-C", tmp, "rev-parse", "HEAD"]);
        commit = stdout.trim() || undefined;
      } catch {
        commit = undefined;
      }
      const picked = subdir ? join(tmp, subdir) : tmp;
      if (subdir && !existsSync(picked)) {
        throw new Error(`sub-directory not found in repo: ${subdir}`);
      }
      await mkdir(dirname(target), { recursive: true });
      // Prefer rename (atomic on same FS); fall back to recursive copy.
      try {
        await rename(picked, target);
      } catch {
        await mkdir(target, { recursive: true });
        await cp(picked, target, { recursive: true });
      }
      return commit;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Local directory copy (honours a `#subdir` fragment too).
  const root = isAbsolute(bare) ? bare : resolve(process.cwd(), bare);
  const src = subdir ? join(root, subdir) : root;
  if (!existsSync(src)) throw new Error(`source not found: ${src}`);
  await mkdir(target, { recursive: true });
  await cp(src, target, { recursive: true });
  return undefined;
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
