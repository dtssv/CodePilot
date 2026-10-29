// OS-level sandboxing for tool execution.
//
// Two enforcement layers, both driven by a single SandboxConfig:
//
// 1. Process layer (bash): commands are wrapped in the strongest
// available OS sandbox —
// macOS : sandbox-exec (Seatbelt) with a generated profile that
// allows reads, restricts writes to the workspace + tmp +
// ~/.codepilot (+ configured writablePaths), and optionally
// denies the network.
// Linux : bwrap (bubblewrap) with / mounted read-only and the
// workspace re-bound read-write; --unshare-net when the
// network is disabled.
// Windows: there is no dependency-free kernel sandbox primitive
// (Job Objects need native code; AppContainer needs
// packaging). We follow the same posture as other coding
// agents (e.g. WSL): if WSL with bwrap is
// reachable, commands are sandboxed through it; otherwise
// the policy fallback applies — "deny" (fail closed) by
// default, i.e. bash refuses to run rather than running
// unsandboxed. The tool-layer guard below is fully
// enforced on Windows regardless.
//
// When no sandbox backend exists and mode != "off", the policy's
// `fallback` decides: "deny" (fail closed, default) or
// "allow-unsandboxed" (run raw with a loud warning in the output).
//
// 2. Tool layer (file tools): assertPathAllowed validates every path
// used by read_file / write_file / edit_file / ls / glob / grep before
// any I/O. Writes are confined to the writable set; reads are allowed
// anywhere except a sensitive deny-list (~/.ssh, credential files,
// /etc/shadow, private keys) which always requires explicit user
// intent (surfaced as an error the model must escalate). Existing
// paths are additionally checked through realpath so symlinks cannot
// escape the writable roots. This layer is pure Node and works
// identically on macOS, Linux and Windows.
//
// This module is dependency-free and never throws from detection: the
// environment is probed once and cached.

import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { SandboxConfig } from "./types.js";

export type SandboxMode = "off" | "workspace-write" | "read-only";

export interface ResolvedSandbox {
  mode: SandboxMode;
  /** True when the command may use the network at all ("full" or "proxy").
   * False only for "off" — kept as the switch for `--unshare-net`. */
  network: boolean;
  /** Normalized network policy. "proxy" carries the allowlist. */
  networkPolicy: {
    mode: "off" | "full" | "proxy";
    allow: string[];
    allowPorts: number[];
    denyLog: boolean;
  };
  writablePaths: string[];
  fallback: "deny" | "allow-unsandboxed";
 /** Absolute paths that file tools may write to (cwd + tmp + extras). */
  writableRoots: string[];
 /** Loopback proxy URL (http://127.0.0.1:PORT) when a "proxy" network policy
  * is active and the proxy has been started. Injected into bash as
  * HTTP(S)_PROXY. Absent until the host starts the proxy and sets it. */
  proxyUrl?: string;
 /** How strongly the "proxy" network policy is enforced for the active
  * backend:
  *  - "enforced": the OS sandbox forces all egress through the proxy (Seatbelt
  *    loopback-only). A child cannot bypass by ignoring HTTP(S)_PROXY.
  *  - "best-effort": cooperative only — the proxy env vars are injected but a
  *    process opening a raw socket can bypass them (bwrap/wsl without a
  *    userspace net stack; or proxy not yet started).
  * Undefined when the network policy is not "proxy". */
  proxyEnforcement?: "enforced" | "best-effort";
}

/**
 * OS temp locations shells and CLIs routinely use (`curl -o /tmp/…`, zsh
 * heredoc scratch files, `mktemp`). `os.tmpdir()` alone is not enough on
 * macOS: it is often under `/var/folders/…` while scripts still write `/tmp`
 * (a symlink to `/private/tmp`). Coding agents generally allow these temps
 * under workspace-write so banal commands don't fail with "operation not
 * permitted".
 */
function defaultTempWritableRoots(): string[] {
  const roots = new Set<string>();
  roots.add(resolve(tmpdir()));
  if (process.env.TMPDIR) roots.add(resolve(process.env.TMPDIR));
  if (process.platform === "darwin" || process.platform === "linux") {
    roots.add("/tmp");
    roots.add("/private/tmp");
  }
  if (process.platform === "win32") {
    if (process.env.TEMP) roots.add(resolve(process.env.TEMP));
    if (process.env.TMP) roots.add(resolve(process.env.TMP));
  }
  return [...roots];
}

/** Resolve a (possibly partial) config into a complete policy for a cwd. */
export function resolveSandbox(
  config: SandboxConfig | undefined,
  cwd: string
): ResolvedSandbox {
  const mode: SandboxMode = config?.mode ?? "workspace-write";
  const writableRoots = [
    resolve(cwd),
    ...defaultTempWritableRoots(),
    resolve(homedir(), ".codepilot"),
    ...(config?.writablePaths ?? []).map((p) => resolve(p)),
  ];
  const networkPolicy = normalizeNetworkPolicy(config?.network);
  return {
    mode,
    network: networkPolicy.mode !== "off",
    networkPolicy,
    writablePaths: (config?.writablePaths ?? []).map((p) => resolve(p)),
    fallback: config?.fallback ?? "deny",
    writableRoots,
  };
}

/** Normalize the boolean/object network config into a single shape.
 * Legacy booleans map: true → "full", false → "off"; undefined → "full". */
function normalizeNetworkPolicy(
  net: SandboxConfig["network"],
): ResolvedSandbox["networkPolicy"] {
  if (net === undefined || net === true) {
    return { mode: "full", allow: [], allowPorts: [80, 443], denyLog: true };
  }
  if (net === false) {
    return { mode: "off", allow: [], allowPorts: [80, 443], denyLog: true };
  }
  return {
    mode: net.mode,
    allow: net.allow ?? [],
    allowPorts: net.allowPorts && net.allowPorts.length > 0 ? net.allowPorts : [80, 443],
    denyLog: net.denyLog ?? true,
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

/** Extract the port from a loopback proxy URL (http://127.0.0.1:PORT). */
function proxyPort(url: string): number | null {
  try {
    const p = Number(new URL(url).port);
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
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
  // Network policy:
  //  - "off"   → deny all network.
  //  - "proxy" → when the loopback proxy is up (proxyUrl set), deny all network
  //    then re-allow outbound only to the proxy's loopback port, so a child
  //    process cannot bypass the allowlist by ignoring HTTP(S)_PROXY. If the
  //    proxy isn't up yet we leave network open (cooperative/best-effort), same
  //    posture as other backends.
  //  - "full"  → unrestricted (no rule).
  if (!policy.network) {
    lines.push("(deny network*)");
  } else if (policy.networkPolicy.mode === "proxy" && policy.proxyUrl) {
    const port = proxyPort(policy.proxyUrl);
    if (port) {
      lines.push("(deny network*)");
      lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    }
  }
 // Sensitive reads are denied even though default allows reads.
  for (const p of SENSITIVE_READ_PATHS) {
    lines.push(`(deny file-read* (subpath ${JSON.stringify(p)}))`);
  }
  lines.push("(deny file-write*)");
 // Seatbelt matches resolved paths, so a root behind a symlink (/tmp,
 // /var/folders on macOS) must be listed under its real path too.
  const roots = new Set<string>();
  for (const root of policy.writableRoots) {
    roots.add(root);
    try {
      roots.add(realpathSync(root));
    } catch {
      // Not created yet — allow the parent so the OS can mkdir `root`.
      const parent = dirname(root);
      if (parent !== root) roots.add(parent);
    }
  }
  for (const root of roots) {
    lines.push(`(allow file-write* (subpath ${JSON.stringify(root)}))`);
    lines.push(`(allow file-write* (literal ${JSON.stringify(root)}))`);
  }
 // `>/dev/null`, `2>&1 | tee /dev/stderr` etc. are not real writes.
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") ' +
      '(literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))'
  );
  return lines.join("\n");
}

/** Wrap a command for the given policy. Never throws. */
/** Prefix `export`s that route a sandboxed command's HTTP(S) traffic through
 * the loopback allowlist proxy, when a "proxy" network policy is active and
 * the host has started the proxy (policy.proxyUrl set). No-op otherwise. */
function withProxyEnv(command: string, policy: ResolvedSandbox): string {
  if (policy.networkPolicy.mode !== "proxy" || !policy.proxyUrl) return command;
  const q = shellQuote(policy.proxyUrl);
  // Set both upper/lowercase forms (tools vary) and clear NO_PROXY so nothing
  // is exempted from the allowlist.
  const exports = [
    `HTTP_PROXY=${q}`,
    `HTTPS_PROXY=${q}`,
    `ALL_PROXY=${q}`,
    `http_proxy=${q}`,
    `https_proxy=${q}`,
    `all_proxy=${q}`,
    `NO_PROXY=''`,
    `no_proxy=''`,
  ].join(" ");
  return `export ${exports}; ${command}`;
}

export function wrapCommand(
  command: string,
  policy: ResolvedSandbox
): WrappedCommand {
  if (policy.mode === "off") {
    return { command, sandboxed: false, backend: "none" };
  }
  // In "proxy" network mode, force child tools through the loopback proxy by
  // exporting the standard proxy env vars ahead of the command. Cooperative:
  // tools that honor HTTP(S)_PROXY are restricted; see netProxy.ts.
  command = withProxyEnv(command, policy);
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

/**
 * System / credential / boot paths where an accidental write or delete is
 * catastrophic or a security risk. A write or delete targeting any of these
 * forces an interactive confirmation EVEN when the sandbox is off or the mode
 * is yolo — the same posture as a dangerous bash command. This is a safety
 * floor, independent of the writable-root math (which only runs when a sandbox
 * is active). It is NOT a hard deny: a user who truly means it can confirm.
 */
export const SENSITIVE_WRITE_PATHS: string[] = [
  // Credentials / keys (clobbering authorized_keys or known_hosts is an attack).
  join2(homedir(), ".ssh"),
  join2(homedir(), ".aws"),
  join2(homedir(), ".gnupg"),
  join2(homedir(), ".kube"),
  // Shell / login startup files (a classic persistence vector).
  join2(homedir(), ".bashrc"),
  join2(homedir(), ".bash_profile"),
  join2(homedir(), ".zshrc"),
  join2(homedir(), ".profile"),
  // System configuration and binaries (POSIX).
  "/etc",
  "/boot",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/System",
  "/Library/LaunchDaemons",
  "/Library/LaunchAgents",
];

function join2(...parts: string[]): string {
  return parts.join(sep);
}

/**
 * Whether `inputPath` resolves onto a protected system/credential path for the
 * given access kind. Mode-independent: this is the safety floor that applies
 * even when the sandbox is off. Returns the matched root (for messaging) or
 * null when the path is not sensitive.
 */
export function sensitivePathHit(
  inputPath: string,
  kind: "read" | "write",
  cwd: string,
): string | null {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const list = kind === "read" ? SENSITIVE_READ_PATHS : SENSITIVE_WRITE_PATHS;
  for (const s of list) {
    if (isUnder(abs, s)) return s;
  }
  return null;
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
 * Directory to grant when the user allows a write outside the sandbox.
 * Uses the parent of a file path (so sibling files in that folder work).
 * If that folder does not exist yet, {@link addWritableRoot} also grants
 * its parent so the OS sandbox can `mkdir` it.
 */
export function writableRootForTarget(inputPath: string, cwd: string): string {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const parent = dirname(abs);
  return parent === abs ? abs : parent;
}

/** True when `inputPath` resolves outside every writable root (write would fail). */
export function isWriteOutsideSandbox(
  inputPath: string,
  policy: ResolvedSandbox,
  cwd: string,
): boolean {
  if (policy.mode === "off" || policy.mode === "read-only") return false;
  return !assertPathAllowed(inputPath, "write", policy, cwd).ok;
}

/** Mutate `policy` to include an extra writable root (idempotent).
 * If `root` does not exist yet, also records its parent in the policy so
 * path-guard checks and the OS profile (see {@link buildSeatbeltProfile})
 * agree that creating `root` is allowed. */
export function addWritableRoot(policy: ResolvedSandbox, root: string): void {
  const abs = resolve(root);
  const toAdd = [abs];
  if (!existsSync(abs)) {
    const parent = dirname(abs);
    if (parent !== abs) toAdd.push(parent);
  }
  for (const p of toAdd) {
    if (!policy.writableRoots.some((r) => normPath(r) === normPath(p))) {
      policy.writableRoots.push(p);
    }
    if (!policy.writablePaths.some((r) => normPath(r) === normPath(p))) {
      policy.writablePaths.push(p);
    }
  }
}

/** True when command output looks like an OS-sandbox write denial (not a
 * parsed path heuristic — just errno-style messages from seatbelt/bwrap). */
export function looksLikeSandboxWriteDenial(text: string): boolean {
  return (
    /Operation not permitted/i.test(text) ||
    /Read-only file system/i.test(text) ||
    /Permission denied/i.test(text) ||
    /\bEPERM\b|\bEROFS\b|\bEACCES\b/.test(text)
  );
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
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);

 // Sensitive reads are always blocked — defence in depth, and crucially this
 // applies EVEN when the sandbox is off (file tools would otherwise have no
 // floor at all with mode="off"). The process sandbox also denies them for bash.
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

 // Reads aside, mode "off" imposes no writable-root constraint. The sensitive
 // WRITE floor is enforced upstream in PermissionEngine (forces an interactive
 // confirmation regardless of mode), so a confirmed write still reaches here
 // and is allowed through.
  if (policy.mode === "off") return { ok: true };

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
 // The roots need the same treatment: on macOS a workspace under
 // /var or /tmp really lives in /private/var, /private/tmp.
        const realRoots = await Promise.all(
          policy.writableRoots.map((r) => realpath(r).catch(() => r)),
        );
        const realPolicy = { ...policy, writableRoots: [...new Set([...policy.writableRoots, ...realRoots])] };
        return assertPathAllowed(real + abs.slice(probe.length), kind, realPolicy, cwd);
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
  { re: /\bgit\s+push\b[^|]*--force(?!-with-lease)/, why: "force push" },
  { re: /\bgit\s+push\b[^|]*--force-with-lease/, why: "force push (with lease)" },
  { re: /\bgit\s+reset\s+--hard/, why: "hard reset" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fx]/, why: "git clean -fx" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "power state change" },
  { re: /\bchmod\s+-R\s+777\s+\//, why: "recursive chmod of /" },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: "raw disk write" },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/, why: "curl pipe to shell" },
  { re: /\bwget\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/, why: "wget pipe to shell" },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, why: "database drop" },
  // Secure-delete / truncation of a system or root path.
  { re: /\bshred\b[^|]*\s\/(?:etc|boot|bin|sbin|usr|System)\b/, why: "secure-delete of system path" },
  { re: /\btruncate\b[^|]*-s\s*0[^|]*\s\/(?:etc|boot|bin|sbin|usr)\b/, why: "truncate of system path" },
  // Recursive delete of a shell glob at root (`rm -rf /*`, `/home/*`).
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/\S*\*/, why: "recursive delete of a root glob" },
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
