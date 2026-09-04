// OS-level sandboxing for tool execution.
//
// Two enforcement layers, both driven by a single SandboxConfig:
//
//   1. Process layer (bash): commands are wrapped in the strongest
//      available OS sandbox —
//        macOS : sandbox-exec (Seatbelt) with a generated profile that
//                allows reads, restricts writes to the workspace + tmp +
//                ~/.codepilot (+ configured writablePaths), and optionally
//                denies the network.
//        Linux : bwrap (bubblewrap) with / mounted read-only and the
//                workspace re-bound read-write; --unshare-net when the
//                network is disabled.
//        Windows: there is no dependency-free kernel sandbox primitive
//                (Job Objects need native code; AppContainer needs
//                packaging). We follow the same posture as other coding
//                agents (e.g. codex recommends WSL): if WSL with bwrap is
//                reachable, commands are sandboxed through it; otherwise
//                the policy fallback applies — "deny" (fail closed) by
//                default, i.e. bash refuses to run rather than running
//                unsandboxed. The tool-layer guard below is fully
//                enforced on Windows regardless.
//
//      When no sandbox backend exists and mode != "off", the policy's
//      `fallback` decides: "deny" (fail closed, default) or
//      "allow-unsandboxed" (run raw with a loud warning in the output).
//
//   2. Tool layer (file tools): assertPathAllowed() validates every path
//      used by read_file / write_file / edit_file / ls / glob / grep before
//      any I/O. Writes are confined to the writable set; reads are allowed
//      anywhere except a sensitive deny-list (~/.ssh, credential files,
//      /etc/shadow, private keys) which always requires explicit user
//      intent (surfaced as an error the model must escalate). Existing
//      paths are additionally checked through realpath so symlinks cannot
//      escape the writable roots. This layer is pure Node and works
//      identically on macOS, Linux and Windows.
//
// This module is dependency-free and never throws from detection: the
// environment is probed once and cached.

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { SandboxConfig } from "./types.js";

export type SandboxMode = "off" | "workspace-write" | "read-only";

export interface ResolvedSandbox {
  mode: SandboxMode;
  network: boolean;
  writablePaths: string[];
  fallback: "deny" | "allow-unsandboxed";
  /** Absolute paths that file tools may write to (cwd + tmp + extras). */
  writableRoots: string[];
}

/** Resolve a (possibly partial) config into a complete policy for a cwd. */
export function resolveSandbox(
  config: SandboxConfig | undefined,
  cwd: string
): ResolvedSandbox {
  const mode: SandboxMode = config?.mode ?? "workspace-write";
  const writableRoots = [
    resolve(cwd),
    resolve(tmpdir()),
    resolve(homedir(), ".codepilot"),
    ...(config?.writablePaths ?? []).map((p) => resolve(p)),
  ];
  return {
    mode,
    network: config?.network ?? true,
    writablePaths: (config?.writablePaths ?? []).map((p) => resolve(p)),
    fallback: config?.fallback ?? "deny",
    writableRoots,
  };
}

// ---------------------------------------------------------------------------
// Layer 1: process sandbox for bash
// ---------------------------------------------------------------------------

export interface WrappedCommand {
  /** The command to pass to the host shell (already wrapped if sandboxed). */
  command: string;
  /** Executable to spawn (default /bin/sh; "wsl.exe" for the WSL backend). */
  shell?: string;
  /** Shell args prefix (e.g. ["-e"] for wsl.exe). */
  shellArgs?: string[];
  sandboxed: boolean;
  /** "seatbelt" | "bwrap" | "wsl-bwrap" | "none" */
  backend: "seatbelt" | "bwrap" | "wsl-bwrap" | "none";
  /** Human-readable note to prefix to output when unsandboxed. */
  warning?: string;
}

export type SandboxBackend = WrappedCommand["backend"];

let cachedBackend: SandboxBackend | null = null;

/** True when WSL is installed and has bubblewrap inside the default distro. */
function probeWslBwrap(): boolean {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("wsl.exe", ["-e", "bwrap", "--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Probe the host for an available sandbox backend. Cached per process. */
export function detectSandboxBackend(): SandboxBackend {
  if (cachedBackend) return cachedBackend;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    cachedBackend = "seatbelt";
  } else if (
    process.platform === "linux" &&
    (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap") || existsSync("/usr/local/bin/bwrap"))
  ) {
    cachedBackend = "bwrap";
  } else if (probeWslBwrap()) {
    cachedBackend = "wsl-bwrap";
  } else {
    cachedBackend = "none";
  }
  return cachedBackend;
}

/** Test hook: reset the cached probe. */
export function resetSandboxBackendCache(): void {
  cachedBackend = null;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the Seatbelt profile for the current policy.
 *
 * The profile starts from `(allow default)` — reads, signals, process
 * management all work — then denies writes globally and re-allows them for
 * the writable roots. Network is denied outright when policy.network is
 * false. Sensitive paths get an explicit read deny *before* the default
 * allow takes effect (Seatbelt evaluates denies with higher precedence
 * than allows for the same operation when listed — we keep the deny rules
 * explicit so the intent is auditable).
 */
export function buildSeatbeltProfile(policy: ResolvedSandbox): string {
  const lines: string[] = [];
  lines.push("(version 1)");
  lines.push("(allow default)");
  if (!policy.network) {
    lines.push("(deny network*)");
  }
  // Sensitive reads are denied even though default allows reads.
  for (const p of SENSITIVE_READ_PATHS) {
    lines.push(`(deny file-read* (subpath ${JSON.stringify(p)}))`);
  }
  lines.push("(deny file-write*)");
  for (const root of policy.writableRoots) {
    lines.push(`(allow file-write* (subpath ${JSON.stringify(root)}))`);
    lines.push(`(allow file-write* (literal ${JSON.stringify(root)}))`);
  }
  return lines.join("\n");
}

/** Wrap a command for the given policy. Never throws. */
export function wrapCommand(
  command: string,
  policy: ResolvedSandbox
): WrappedCommand {
  if (policy.mode === "off") {
    return { command, sandboxed: false, backend: "none" };
  }
  const backend = detectSandboxBackend();
  if (backend === "none") {
    if (policy.fallback === "allow-unsandboxed") {
      return {
        command,
        sandboxed: false,
        backend: "none",
        warning:
          `[sandbox] WARNING: no OS sandbox available on this host ` +
          `(${process.platform}); command is running UNSANDBOXED. ` +
          `Install bubblewrap (Linux) or set sandbox.fallback="deny".`,
      };
    }
    return {
      command: `echo ${shellQuote(
        `[sandbox] denied: sandbox mode "${policy.mode}" is configured but no ` +
          `OS sandbox (sandbox-exec / bwrap) is available on this host. ` +
          `Set sandbox.mode="off" or sandbox.fallback="allow-unsandboxed" to override.`
      )} >&2; exit 126`,
      sandboxed: false,
      backend: "none",
    };
  }
  if (backend === "seatbelt") {
    const profile = buildSeatbeltProfile(policy);
    return {
      command: `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/sh -c ${shellQuote(command)}`,
      sandboxed: true,
      backend,
    };
  }
  if (backend === "wsl-bwrap") {
    // Windows path: re-exec the command inside the default WSL distro under
    // bwrap. The Windows cwd is mapped via /mnt/<drive>/...; writable roots
    // are translated the same way. Network restriction uses --unshare-net.
    const wslRoots = policy.writableRoots.map(winPathToWsl);
    const wslCwd = winPathToWsl(policy.writableRoots[0] ?? resolve("/"));
    const args: string[] = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    for (const root of wslRoots) {
      args.push("--bind", root, root);
    }
    if (!policy.network) args.push("--unshare-net");
    args.push("--", "/bin/sh", "-c", `cd ${shellQuote(wslCwd)} && ${command}`);
    return {
      command: args.map(shellQuote).join(" "),
      shell: "wsl.exe",
      shellArgs: ["-e"],
      sandboxed: true,
      backend,
    };
  }
  // bwrap: mount / read-only, re-bind writable roots rw, fresh /dev+/proc.
  const args: string[] = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const root of policy.writableRoots) {
    if (existsSync(root)) args.push("--bind", root, root);
  }
  if (!policy.network) args.push("--unshare-net");
  args.push("--", "/bin/sh", "-c", command);
  const bwrapCmd = args.map(shellQuote).join(" ");
  return { command: bwrapCmd, sandboxed: true, backend };
}

/** Translate a Windows path (C:\foo\bar) to its WSL mount (/mnt/c/foo/bar). */
export function winPathToWsl(p: string): string {
  const m = p.match(/^([A-Za-z]):[\\\/](.*)$/);
  if (!m) return p.replace(/\\/g, "/");
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
}

// ---------------------------------------------------------------------------
// Layer 2: file-tool path guard
// ---------------------------------------------------------------------------

/**
 * Paths that file tools (and the Seatbelt profile) refuse to read, no
 * matter the mode. Reads of these require the user to do it themselves.
 */
export const SENSITIVE_READ_PATHS: string[] = [
  join2(homedir(), ".ssh"),
  join2(homedir(), ".aws", "credentials"),
  join2(homedir(), ".gnupg"),
  join2(homedir(), ".kube", "config"),
  "/etc/shadow",
  "/etc/sudoers",
];

function join2(...parts: string[]): string {
  return parts.join(sep);
}

export interface PathCheckResult {
  ok: boolean;
  reason?: string;
}

/** Case-insensitive path comparison on Windows (NTFS is case-preserving). */
function normPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function isUnder(path: string, root: string): boolean {
  const p = normPath(path);
  const r = normPath(root);
  if (p === r) return true;
  return p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Validate a path against the policy. `kind` is "read" or "write".
 * Absolute and relative paths are both accepted; they are resolved against
 * `cwd` first. Symlinks are not resolved here (the process sandbox catches
 * symlink escapes for bash; file tools additionally use realpath callers
 * where it matters).
 */
export function assertPathAllowed(
  inputPath: string,
  kind: "read" | "write",
  policy: ResolvedSandbox,
  cwd: string
): PathCheckResult {
  if (policy.mode === "off") return { ok: true };
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);

  // Sensitive reads are always blocked (defence in depth — the process
  // sandbox also denies them for bash).
  if (kind === "read") {
    for (const s of SENSITIVE_READ_PATHS) {
      if (isUnder(abs, s)) {
        return {
          ok: false,
          reason:
            `sandbox: reading ${abs} is blocked (sensitive path). ` +
            `Ask the user to provide the needed information directly.`,
        };
      }
    }
    return { ok: true };
  }

  // Writes.
  if (policy.mode === "read-only") {
    return {
      ok: false,
      reason: `sandbox: mode is read-only; writing ${abs} is not allowed.`,
    };
  }
  for (const root of policy.writableRoots) {
    if (isUnder(abs, root)) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `sandbox: writing ${abs} is outside the writable roots ` +
      `(${policy.writableRoots.join(", ")}). ` +
      `Add it to sandbox.writablePaths or sandbox.mode="off" to allow.`,
  };
}

/**
 * Async variant that also resolves symlinks for existing paths, so a
 * symlink inside the workspace cannot be used to escape the writable
 * roots. Non-existent paths (new files) fall back to the lexical check on
 * the deepest existing ancestor.
 */
export async function assertPathAllowedAsync(
  inputPath: string,
  kind: "read" | "write",
  policy: ResolvedSandbox,
  cwd: string
): Promise<PathCheckResult> {
  const lexical = assertPathAllowed(inputPath, kind, policy, cwd);
  if (!lexical.ok || policy.mode === "off") return lexical;
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  // Resolve the nearest existing ancestor and re-check the real location.
  let probe = abs;
  for (let i = 0; i < 32; i++) {
    try {
      const real = await realpath(probe);
      if (real !== probe) {
        return assertPathAllowed(real + abs.slice(probe.length), kind, policy, cwd);
      }
      return lexical;
    } catch {
      // probe does not exist — walk up one level.
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
  }
  return lexical;
}

// ---------------------------------------------------------------------------
// Dangerous command detection (belt-and-braces on top of both layers)
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?\/(?:\s|$)/, why: "recursive delete of /" },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+~(?:\s|\/|$)/, why: "recursive delete of $HOME" },
  { re: /\bmkfs\b/, why: "filesystem format" },
  { re: /\bdd\b[^|]*\bof=\/dev\//, why: "raw disk write" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, why: "fork bomb" },
  { re: /\bgit\s+push\b[^|]*--force/, why: "force push" },
  { re: /\bgit\s+reset\s+--hard/, why: "hard reset" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fx]/, why: "git clean -fx" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "power state change" },
  { re: /\bchmod\s+-R\s+777\s+\//, why: "recursive chmod of /" },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: "raw disk write" },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/, why: "curl pipe to shell" },
  { re: /\bwget\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/, why: "wget pipe to shell" },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, why: "database drop" },
];

export interface DangerCheck {
  dangerous: boolean;
  why?: string;
}

/**
 * Static scan of a shell command for catastrophic patterns. A hit does NOT
 * auto-deny — it forces an interactive permission ask even in yolo mode,
 * unless a deny rule kills it first or an explicit allow rule covers it.
 */
export function checkDangerousCommand(command: string): DangerCheck {
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(command)) return { dangerous: true, why };
  }
  return { dangerous: false };
}
