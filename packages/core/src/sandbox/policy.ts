// OS-level sandboxing for tool execution. Two layers driven by one
// SandboxConfig: process layer (bash via sandbox-exec/bwrap/WSL) and tool
// layer (assertPathAllowed validates paths before I/O). Pure Node;
// dependency-free; never throws from detection.

import { existsSync, readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { SandboxConfig } from "../types.js";
import { projectStatePath } from "../workspace/projectState.js";
import {
  type ResolvedSandbox,
  type SandboxMode,
  type PathCheckResult,
  SANDBOX_PROMPT_EXTRA_ROOTS_CAP,
  type DangerCheck,
} from "./types.js";

/**
 * Lean sandbox posture for volatile session notes. Advertise mode/network and
 * a one-line jail rule; list only *extra* granted roots (capped) — never the
 * full `writableRoots` dump. Permission tier lives in `<runtime>permission:`,
 * not here. Extras stay listed while granted: `<runtime_context>` is rebuilt
 * each turn and is not cumulative in the transcript.
 */
export function formatSandboxPromptNote(opts: {
  mode: SandboxMode;
  network: boolean;
  /** User/config extras only (`writablePaths`), not cwd/tmp/.codepilot. */
  extraWritablePaths: readonly string[];
  /** When set, append the unavailable-backend warning. */
  unavailableHint?: string;
  /** Cap on how many extras to list (default {@link SANDBOX_PROMPT_EXTRA_ROOTS_CAP}). */
  extraCap?: number;
}): string {
  const cap = opts.extraCap ?? SANDBOX_PROMPT_EXTRA_ROOTS_CAP;
  const extras = opts.extraWritablePaths.filter((p) => p.trim().length > 0);
  const shown = extras.slice(0, cap);
  const omitted = extras.length - shown.length;
  const lines: string[] = [
    `Sandbox: mode=${opts.mode}, network=${opts.network ? "allowed" : "blocked"}.`,
    `OS jail: cwd + OS temp + ~/.codepilot` +
      (extras.length > 0 ? ` + ${extras.length} extra` : "") +
      `. Outside → request access; do not tweak-and-retry.`,
  ];
  if (shown.length > 0) {
    lines.push("Extra writable roots:");
    for (const r of shown) lines.push(`  - ${r}`);
    if (omitted > 0) {
      lines.push(`  (+${omitted} more not listed; request access for a specific path if needed)`);
    }
  }
  if (opts.unavailableHint) {
    lines.push(
      `WARNING: no OS sandbox backend is available on this host; \`bash\` commands will be REFUSED. ${opts.unavailableHint}`,
    );
  }
  return lines.join("\n");
}

/**
 * OS temp locations shells/CLIs use (`curl -o /tmp/…`, `mktemp`). `os.tmpdir()`
 * alone is insufficient on macOS (often `/var/folders/…` while scripts write
 * `/tmp` → `/private/tmp`). Allowed under workspace-write.
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
  // Whether to carve `.git` read-only at the OS layer. Default: leave writable
  // (git CLI works); the file-tool layer still gates direct `.git/…` writes.
  // Precedence: `gitWrite` wins when set ("protect" carves, others do not);
  // otherwise legacy `protectGit` (true carves); neither set → writable.
  const protectGit =
    config?.gitWrite !== undefined
      ? config.gitWrite === "protect"
      : config?.protectGit === true;
  return {
    mode,
    network: networkPolicy.mode !== "off",
    networkPolicy,
    writablePaths: (config?.writablePaths ?? []).map((p) => resolve(p)),
    fallback: config?.fallback ?? "deny",
    writableRoots,
    protectedSubpaths: protectGit ? resolveProtectedGitPaths(writableRoots) : [],
    controlPaths: codepilotControlPaths(cwd),
  };
}

/** Files under `~/.codepilot` that only the host process may write: config
 * and MCP settings, trust stores (global + this project's), user plugins and
 * skills, scheduled prompts, the self-updating binary, daemon credentials. */
export function codepilotControlPaths(cwd: string): string[] {
  const root = resolve(homedir(), ".codepilot");
  return [
    ...[...CODEPILOT_CONTROL_FILES, ...CODEPILOT_CREDENTIAL_FILES].map((n) => join2(root, n)),
    projectStatePath(cwd, "mcp-trust.json"),
    projectStatePath(cwd, "hook_trust.json"),
  ];
}

const CODEPILOT_CONTROL_FILES = [
  "config.json",
  "mcp.json",
  "mcp-trust.json",
  "plugins",
  "skills",
  "bin",
  "scheduled-tasks.json",
];

/** Daemon / remote-control credential files: unreadable from the jail too, or
 * a sandboxed command could lift the token and drive the unsandboxed daemon. */
const CODEPILOT_CREDENTIAL_FILES = ["server.json", "serve.json", "remote-control.json"];

/**
 * For each writable root, resolve the `.git` directory that must stay
 * read-only — handles a plain dir and a linked-worktree `.git` file (follows
 * the `gitdir:` pointer). Returns absolute, deduplicated, existing paths.
 */
function resolveProtectedGitPaths(writableRoots: string[]): string[] {
  const out = new Set<string>();
  for (const root of writableRoots) {
    const dotGit = join2(root, ".git");
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(dotGit);
    } catch {
      continue; // no .git here
    }
    if (stat.isDirectory()) {
      out.add(dotGit);
      continue;
    }
    // `.git` is a file (linked worktree / submodule) — follow the gitdir pointer.
    out.add(dotGit); // the pointer file itself must not be rewritten
    try {
      const text = readFileSync(dotGit, "utf8");
      const m = text.match(/^gitdir:\s*(.+)\s*$/m);
      if (m && m[1]) {
        const target = m[1].trim();
        const abs = target.startsWith("/") ? resolve(target) : resolve(root, target);
        // Protect the worktree's own gitdir and the shared common dir (…/.git).
        out.add(abs);
        const commonIdx = abs.lastIndexOf(`${sep}.git${sep}`);
        if (commonIdx >= 0) out.add(abs.slice(0, commonIdx + `${sep}.git`.length));
      }
    } catch {
      /* unreadable pointer — the pointer file is still protected above */
    }
  }
  return [...out];
}

/** Whether jailed commands get no network at all: mode "off", or "proxy"
 * egress requested while no proxy is running (fail closed — never fall back
 * to full egress because the proxy failed to start). */
export function networkDenied(policy: ResolvedSandbox): boolean {
  return !policy.network || (policy.networkPolicy.mode === "proxy" && !policy.proxyUrl);
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
  ...CODEPILOT_CREDENTIAL_FILES.map((n) => join2(homedir(), ".codepilot", n)),
];

/**
 * System/credential/boot paths where an accidental write or delete is
 * catastrophic: forces interactive confirmation even with sandbox off or yolo
 * mode. Not a hard deny — a user who means it can confirm.
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
  ...CODEPILOT_CONTROL_FILES.map((n) => join2(homedir(), ".codepilot", n)),
];

function join2(...parts: string[]): string {
  return parts.join(sep);
}

/**
 * Whether `inputPath` resolves onto a protected system/credential path for the
 * given access kind — the safety floor that applies even with the sandbox off.
 * Returns the matched root (for messaging) or null.
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

/**
 * Whether a write targets a `.git/` directory — forces interactive confirmation
 * (even yolo/under sandbox) since a direct write can corrupt history or plant a
 * hook. `.git` must be a whole path component. Returns the dir path or null.
 */
export function gitMetadataWriteHit(inputPath: string, cwd: string): string | null {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const parts = abs.split(/[/\\]/);
  const idx = parts.indexOf(".git");
  // Must be a .git *directory* with something under it (or the dir itself).
  if (idx === -1) return null;
  return parts.slice(0, idx + 1).join(sep);
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
 * Directory to grant when the user allows a write outside the sandbox: the
 * parent of the file path (so sibling files work). {@link addWritableRoot}
 * also grants a non-existent parent so the OS sandbox can `mkdir` it.
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

/**
 * True when `inputPath` is inside the working set (cwd ∪ extra dirs ∪ `roots`).
 * Prefix check with platform-aware normalization (no symlink resolution — use
 * the async guard).
 */
export function isInsideWorkingSet(
  inputPath: string,
  cwd: string,
  roots: readonly string[],
): boolean {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  if (isUnder(abs, cwd)) return true;
  for (const r of roots) {
    if (r && isUnder(abs, r)) return true;
  }
  return false;
}

/** Deep-copy a resolved policy so the copy can be mutated (e.g. {@link
 * addWritableRoot}) without widening the original. The nested arrays and the
 * networkPolicy object are copied — a shallow spread would alias the parent's
 * `writableRoots`/`writablePaths` and leak the extra root back into it. */
export function cloneSandbox(policy: ResolvedSandbox): ResolvedSandbox {
  return {
    ...policy,
    networkPolicy: {
      ...policy.networkPolicy,
      allow: [...policy.networkPolicy.allow],
      allowPorts: [...policy.networkPolicy.allowPorts],
    },
    writablePaths: [...policy.writablePaths],
    writableRoots: [...policy.writableRoots],
    protectedSubpaths: [...policy.protectedSubpaths],
  };
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

/** True when command output looks like a network failure the sandbox likely
 * caused (disabled network / bwrap --unshare-net / proxy allowlist). Used to
 * nudge toward a one-command escalation. Deliberately broad. */
export function looksLikeSandboxNetworkDenial(text: string): boolean {
  return (
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)\b/.test(text) ||
    /Could not resolve host/i.test(text) ||
    /Temporary failure in name resolution/i.test(text) ||
    /Network is unreachable/i.test(text) ||
    /Connection refused/i.test(text) ||
    /(getaddrinfo|dns).{0,40}(failed|ENOTFOUND|EAI_AGAIN)/i.test(text) ||
    /proxy.{0,30}(refused|denied|blocked)/i.test(text)
  );
}

/**
 * Validate a path against the policy. `kind` is "read" or "write"; absolute and
 * relative paths resolve against `cwd`. Symlinks aren't resolved here — the
 * process sandbox catches escapes for bash, file tools use realpath callers.
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
 * Async variant that also resolves symlinks for existing paths, so a symlink
 * inside the workspace can't escape the writable roots. Non-existent paths
 * fall back to the lexical check on the deepest existing ancestor.
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
  // Destructive removal of a repo's .git directory — catastrophic even inside
  // the workspace. Matches `rm -rf .git` / `path/to/.git` (whole path component
  // only, so `foo.gitignore` is not caught). Only `rm` is flagged; `git`
  // subcommands keep their own patterns above.
  {
    re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\S*\/)?\.git(?:\/\S*)?(?:\s|$)/,
    why: "delete of a .git directory",
  },
];

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
