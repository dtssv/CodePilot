/**
 * In-place self-update for the npm-prefix install under ~/.codepilot
 * (or CODEPILOT_INSTALL_DIR).
 *
 * - Not a reinstall: downloads release tarballs and runs
 *   `npm install --prefix <installRoot> …` over the existing tree.
 * - Startup: one check when {@link startSelfUpdateWatcher} is called.
 * - Long-lived processes: another check every 24h while the process stays up.
 * - Skips when not a prefix install, when CODEPILOT_SKIP_UPDATE is set,
 *   or when `--no-update` / CODEPILOT_NO_UPDATE is set.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, sep, dirname } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CORE_VERSION } from "./eventMeta.js";

const require = createRequire(import.meta.url);

export const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_REPO = "dtssv/CodePilot";
const PACKAGES = ["core", "protocol", "tui"] as const;

export interface UpdateCheckResult {
  current: string;
  latest: string;
  available: boolean;
  tag: string;
  installRoot: string | null;
}

/** Structured engine-channel status (distinct from IDE plugin / VSIX updates). */
export interface EngineUpdateInfo {
  channel: "engine";
  current: string;
  latest: string | null;
  available: boolean;
  tag?: string;
  installRoot: string | null;
  /** True only for npm-prefix installs under ~/.codepilot (or CODEPILOT_INSTALL_DIR). */
  canAutoApply: boolean;
}

export interface SelfUpdateOptions {
  /** GitHub owner/repo. */
  repo?: string;
  /** Override install prefix (default: detect or ~/.codepilot). */
  installRoot?: string;
  /** Logger (default: stderr). */
  log?: (msg: string) => void;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** When true, only report — do not download/install. */
  checkOnly?: boolean;
  /** Skip network (tests). */
  disabled?: boolean;
}

export interface SelfUpdateWatcherHandle {
  /** Run an immediate check (same as the daily tick). */
  checkNow: () => Promise<UpdateCheckResult | null>;
  /** Stop the daily timer. */
  stop: () => void;
}

let watcherStarted = false;

function envDisabled(): boolean {
  const v = process.env.CODEPILOT_SKIP_UPDATE ?? process.env.CODEPILOT_NO_UPDATE;
  return v === "1" || v === "true" || v === "yes";
}

function defaultLog(msg: string): void {
  process.stderr.write(`[codepilot] ${msg}\n`);
}

function githubApi(): string {
  return process.env.GITHUB_API ?? "https://api.github.com";
}

function githubDl(): string {
  return process.env.GITHUB_DL ?? "https://github.com";
}

/** Strip leading `v` for semver-ish compare. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

/**
 * Compare dotted versions: returns >0 if a>b, <0 if a<b, 0 if equal.
 * Non-numeric segments compare lexicographically.
 */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.+-]/);
  const pb = normalizeVersion(b).split(/[.+-]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function currentInstalledVersion(): string {
  try {
    const v = (require("../package.json") as { version?: string }).version;
    if (v) return v;
  } catch {
 /* ignore */
  }
  return CORE_VERSION;
}

/**
 * Detect the npm `--prefix` root used by install.sh.
 * Returns null for monorepo / pkg / IDE-bundled layouts (no self-update).
 */
export function detectInstallRoot(): string | null {
  if (process.env.CODEPILOT_INSTALL_DIR) {
    return process.env.CODEPILOT_INSTALL_DIR;
  }
  const marker = `${sep}lib${sep}node_modules${sep}@codepilot${sep}`;
  const probes: string[] = [];
  try {
    probes.push(fileURLToPath(import.meta.url));
  } catch {
 /* ignore */
  }
  if (process.argv[1]) probes.push(process.argv[1]);
  try {
    probes.push(require.resolve("@codepilot/core/package.json"));
  } catch {
 /* ignore */
  }

  for (const p of probes) {
    const idx = p.indexOf(marker);
    if (idx >= 0) return p.slice(0, idx);
  }

  const home = join(homedir(), ".codepilot");
  if (existsSync(join(home, "lib", "node_modules", "@codepilot", "core", "package.json"))) {
    return home;
  }
  return null;
}

async function fetchLatestTag(
  repo: string,
  fetchImpl: typeof fetch,
): Promise<{ tag: string; version: string } | null> {
  const url = `${githubApi()}/repos/${repo}/releases/latest`;
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "codepilot-self-update",
    },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { tag_name?: string };
  const tag = json.tag_name?.trim();
  if (!tag) return null;
  return { tag, version: normalizeVersion(tag) };
}

async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "codepilot-self-update" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`download failed ${res.status}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function npmInstallPrefix(prefix: string, tarballs: string[]): void {
  const args = ["install", "-g", "--prefix", prefix, ...tarballs];
  const r = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`npm install failed (exit ${r.status}): ${err.slice(0, 500)}`);
  }
}

function statePath(installRoot: string): string {
  return join(installRoot, "update-state.json");
}

function writeUpdateState(
  installRoot: string,
  patch: Record<string, unknown>,
): void {
  try {
    mkdirSync(installRoot, { recursive: true });
    const path = statePath(installRoot);
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
 /* ignore */
    }
    writeFileSync(path, JSON.stringify({ ...prev, ...patch }, null, 2) + "\n");
  } catch {
 /* ignore */
  }
}

/**
 * Check GitHub for a newer **engine** release.
 * Works without an install root (reports versions / availability; `canAutoApply` false).
 * Does not install. Distinct from IDE plugin / VSIX updates.
 */
export async function checkEngineUpdate(
  opts: SelfUpdateOptions = {},
): Promise<EngineUpdateInfo | null> {
  if (opts.disabled || envDisabled()) return null;

  // Explicit `installRoot: ""` / undefined-in-object means "no prefix" (report-only).
  const installRoot =
    opts.installRoot !== undefined ? opts.installRoot || null : detectInstallRoot();
  const current = currentInstalledVersion();
  const repo = opts.repo ?? process.env.CODEPILOT_REPO ?? DEFAULT_REPO;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const latest = await fetchLatestTag(repo, fetchImpl);
  if (!latest) {
    return {
      channel: "engine",
      current,
      latest: null,
      available: false,
      installRoot,
      canAutoApply: !!installRoot,
    };
  }

  const tag = latest.tag.startsWith("v") ? latest.tag : `v${latest.version}`;
  return {
    channel: "engine",
    current,
    latest: latest.version,
    tag,
    available: compareVersions(latest.version, current) > 0,
    installRoot,
    canAutoApply: !!installRoot,
  };
}

/**
 * Check GitHub for a newer release when a prefix install exists. Does not install.
 * Prefer {@link checkEngineUpdate} when you need status without an install root.
 */
export async function checkForUpdate(
  opts: SelfUpdateOptions = {},
): Promise<UpdateCheckResult | null> {
  const info = await checkEngineUpdate(opts);
  if (!info || !info.installRoot || !info.latest || !info.tag) return null;
  return {
    current: info.current,
    latest: info.latest,
    tag: info.tag,
    available: info.available,
    installRoot: info.installRoot,
  };
}

/**
 * Download release tarballs and `npm install --prefix` over the existing tree.
 * Returns the installed version string.
 */
export async function applyUpdate(
  check: UpdateCheckResult,
  opts: SelfUpdateOptions = {},
): Promise<string> {
  if (!check.installRoot) throw new Error("no install root");
  if (!check.available) return check.current;

  const log = opts.log ?? defaultLog;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const repo = opts.repo ?? process.env.CODEPILOT_REPO ?? DEFAULT_REPO;
  const ver = check.latest;
  const tag = check.tag;
  const tmp = mkdtempSync(join(tmpdir(), "codepilot-update-"));
  try {
    log(`Updating ${check.current} → ${ver} (in-place, prefix=${check.installRoot})`);
    const tarballs: string[] = [];
    for (const name of PACKAGES) {
      const file = `codepilot-${name}-${ver}.tgz`;
      const url = `${githubDl()}/${repo}/releases/download/${tag}/${file}`;
      const dest = join(tmp, file);
      log(`↓ ${file}`);
      await downloadFile(url, dest, fetchImpl);
      tarballs.push(dest);
    }
    npmInstallPrefix(check.installRoot, tarballs);
    writeUpdateState(check.installRoot, {
      lastAppliedVersion: ver,
      lastAppliedAt: new Date().toISOString(),
      previousVersion: check.current,
    });
    log(`Updated to ${ver}. Restart CodePilot to load the new version.`);
    return ver;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
 /* ignore */
    }
  }
}

/**
 * Check once; if a newer release exists, apply in-place update unless checkOnly.
 */
export async function runUpdateCheck(
  opts: SelfUpdateOptions = {},
): Promise<UpdateCheckResult | null> {
  const log = opts.log ?? defaultLog;
  try {
    const check = await checkForUpdate(opts);
    if (!check) return null;
    writeUpdateState(check.installRoot!, {
      lastCheckedAt: new Date().toISOString(),
      lastCheckedVersion: check.latest,
    });
    if (!check.available) {
      return check;
    }
    log(`Update available: ${check.current} → ${check.latest}`);
    if (opts.checkOnly) return check;
    await applyUpdate(check, opts);
    return { ...check, current: check.latest, available: false };
  } catch (err) {
    log(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Start the process-lifetime updater: one check now, then every 24h.
 * Safe to call once per process; subsequent calls are no-ops.
 */
export function startSelfUpdateWatcher(
  opts: SelfUpdateOptions = {},
): SelfUpdateWatcherHandle {
  const log = opts.log ?? defaultLog;
  const checkNow = () => runUpdateCheck(opts);

  if (watcherStarted || opts.disabled || envDisabled()) {
    return {
      checkNow,
      stop: () => undefined,
    };
  }
  watcherStarted = true;

  // Non-blocking startup check.
  void checkNow();

  const timer = setInterval(() => {
    void checkNow();
  }, DAY_MS);
  // Don't keep the process alive solely for updates.
  timer.unref?.();

  return {
    checkNow,
    stop: () => {
      clearInterval(timer);
      watcherStarted = false;
    },
  };
}

/** Test helper: reset the singleton so another watcher can start. */
export function resetSelfUpdateWatcherForTests(): void {
  watcherStarted = false;
}

/** Resolve package dir for debugging (unused externally). */
export function _packageDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
