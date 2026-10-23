/**
 * Shared helpers for cross-platform packaging scripts.
 * Pure Node — no bash / PowerShell required.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  createWriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RELEASE_ROOT = join(REPO_ROOT, "dist", "release");
export const CACHE_ROOT = join(REPO_ROOT, "scripts", "package", ".cache");

const require = createRequire(import.meta.url);

/** @typedef {"win" | "mac" | "linux"} OsFamily */

/**
 * @returns {{ family: OsFamily, arch: string, pkgTarget: string, binarySuffix: string }}
 */
export function currentPlatform() {
  const family =
    process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return {
    family,
    arch,
    pkgTarget: pkgTargetFor(family, arch),
    binarySuffix: binaryNameSuffix(family, arch),
  };
}

/** @param {OsFamily} family @param {string} arch */
export function pkgTargetFor(family, arch) {
  if (family === "win") return arch === "arm64" ? "node20-win-arm64" : "node20-win-x64";
  if (family === "mac") return arch === "arm64" ? "node20-macos-arm64" : "node20-macos-x64";
  return arch === "arm64" ? "node20-linux-arm64" : "node20-linux-x64";
}

/** @param {OsFamily} family @param {string} arch */
export function binaryNameSuffix(family, arch) {
  if (family === "win") return `win-${arch === "arm64" ? "arm64" : "x64"}.exe`;
  if (family === "mac") return `darwin-${arch}`;
  return `linux-${arch === "arm64" ? "arm64" : "x64"}`;
}

/**
 * Parse PACKAGE_TARGETS / argv for which platforms to build.
 * Default: current host only. `--all` or PACKAGE_TARGETS=win,mac,linux for more.
 * @param {string[]} argv
 * @returns {Array<{ family: OsFamily, arch: string, pkgTarget: string, binarySuffix: string }>}
 */
export function resolveTargets(argv = process.argv.slice(2)) {
  const all = argv.includes("--all") || process.env.PACKAGE_TARGETS === "all";
  const env = process.env.PACKAGE_TARGETS;
 /** @type {OsFamily[]} */
  let families = [];
  if (all) {
    families = ["win", "mac", "linux"];
  } else if (env && env !== "all") {
    families = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s === "darwin" ? "mac" : s === "windows" ? "win" : s));
  } else if (argv.some((a) => a.startsWith("--platform="))) {
    const raw = argv.find((a) => a.startsWith("--platform=")).slice("--platform=".length);
    families = raw.split(",").map((s) => (s === "darwin" ? "mac" : s === "windows" ? "win" : s));
  } else {
    return [currentPlatform()];
  }

 /** @type {Array<{ family: OsFamily, arch: string, pkgTarget: string, binarySuffix: string }>} */
  const out = [];
  for (const family of families) {
    if (family === "mac") {
      out.push({
        family: "mac",
        arch: "arm64",
        pkgTarget: pkgTargetFor("mac", "arm64"),
        binarySuffix: binaryNameSuffix("mac", "arm64"),
      });
      out.push({
        family: "mac",
        arch: "x64",
        pkgTarget: pkgTargetFor("mac", "x64"),
        binarySuffix: binaryNameSuffix("mac", "x64"),
      });
    } else if (family === "win") {
      out.push({
        family: "win",
        arch: "x64",
        pkgTarget: pkgTargetFor("win", "x64"),
        binarySuffix: binaryNameSuffix("win", "x64"),
      });
    } else if (family === "linux") {
      out.push({
        family: "linux",
        arch: "x64",
        pkgTarget: pkgTargetFor("linux", "x64"),
        binarySuffix: binaryNameSuffix("linux", "x64"),
      });
      out.push({
        family: "linux",
        arch: "arm64",
        pkgTarget: pkgTargetFor("linux", "arm64"),
        binarySuffix: binaryNameSuffix("linux", "arm64"),
      });
    }
  }
  return out.length ? out : [currentPlatform()];
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

export function log(msg) {
  process.stderr.write(`[package] ${msg}\n`);
}

export function fail(msg, code = 1) {
  process.stderr.write(`[package] ERROR: ${msg}\n`);
  process.exit(code);
}

/**
 * Run a command; throw / exit on failure.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, allowFail?: boolean }} [opts]
 */
export function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) {
    if (opts.allowFail) {
      log(`failed: ${r.error.message}`);
      return r.status ?? 1;
    }
    fail(r.error.message);
  }
  if (r.status !== 0) {
    if (opts.allowFail) {
      log(`exit ${r.status}`);
      return r.status ?? 1;
    }
    fail(`${cmd} exited ${r.status}`);
  }
  return 0;
}

export function pnpm(args, opts) {
  return run("corepack", ["pnpm", ...args], opts);
}

/** Zip a directory to `outZip` using best available tool (PowerShell / zip / Node fallback). */
export async function zipDir(srcDir, outZip) {
  ensureDir(dirname(outZip));
  if (existsSync(outZip)) rmSync(outZip, { force: true });

  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${outZip.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (ps.status === 0) return;
  } else {
    const z = spawnSync("zip", ["-r", "-q", outZip, "."], { cwd: srcDir, stdio: "inherit" });
    if (z.status === 0) return;
  }

 // Minimal stored-zip fallback (no compression) via dynamic import of no deps
 // use `tar` if present, else copy instruction.
  const tar = spawnSync("tar", ["-a", "-cf", outZip, "-C", srcDir, "."], { stdio: "inherit" });
  if (tar.status === 0) return;

  fail(`Could not create zip at ${outZip} (need zip, tar, or PowerShell Compress-Archive)`);
}

export function copyTree(src, dest) {
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true });
}

export function listFiles(dir, pred) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return pred(p, basename(p), statSync(p));
      } catch {
        return false;
      }
    });
}

/** Resolve @yao-pkg/pkg binary via require.resolve. */
export function pkgBin() {
  try {
    return require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
  } catch {
    try {
      return require.resolve("@yao-pkg/pkg");
    } catch {
      fail("Install @yao-pkg/pkg: pnpm add -Dw @yao-pkg/pkg");
    }
  }
}

export function electronBuilderBin() {
  try {
    return join(dirname(require.resolve("electron-builder/package.json")), "cli.js");
  } catch {
    fail("Install electron-builder: pnpm add -Dw electron-builder (or in apps/desktop)");
  }
}

/**
 * Find the packaged binary for the current host under releaseDir.
 * @param {string} releaseDir
 * @param {string} namePrefix e.g. "codepilot" or "codepilot-tui"
 */
export function findHostBinary(releaseDir, namePrefix) {
  const { binarySuffix } = currentPlatform();
  const exact = join(releaseDir, `${namePrefix}-${binarySuffix}`);
  if (existsSync(exact)) return exact;
 // loose match
  const files = listFiles(releaseDir, (p, name, st) => st.isFile() && name.startsWith(namePrefix));
  const host = currentPlatform();
  const hit = files.find((f) => f.includes(host.family === "mac" ? "darwin" : host.family));
  return hit ?? files[0];
}

export function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// silence unused import lint for pipeline/Readable if zip fallback unused
void pipeline;
void Readable;
void require;
