// OS-level sandboxing for tool execution. Two layers driven by one
// SandboxConfig: process layer (bash via sandbox-exec/bwrap/WSL) and tool
// layer (assertPathAllowed validates paths before I/O). Pure Node;
// dependency-free; never throws from detection.

import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
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
 /** Absolute paths carved out of the writable roots as read-only at the OS
  * layer, even though they sit inside a writable root. Protects repository
  * metadata (resolved `.git` directories) so an approved bash command cannot
  * rewrite hooks/config/objects. Empty by default (git CLI works under the
  * sandbox); populated only when `gitWrite: "protect"` / `protectGit: true`. */
  protectedSubpaths: string[];
 /** Loopback proxy URL (http://127.0.0.1:PORT) when a "proxy" network policy
  * is active and the proxy has been started. Injected into bash as
  * HTTP(S)_PROXY. Absent until the host starts the proxy and sets it. */
  proxyUrl?: string;
 /** How strongly the "proxy" policy is enforced: "enforced" = OS sandbox
  * forces all egress through the proxy; "best-effort" = cooperative only
  * (env vars injected but a raw socket can bypass). Undefined when not "proxy". */
  proxyEnforcement?: "enforced" | "best-effort";
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
  };
}

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
 /** "seatbelt" | "bwrap" | "landlock" | "wsl-bwrap" | "none" */
  backend: "seatbelt" | "bwrap" | "landlock" | "wsl-bwrap" | "none";
 /** Human-readable note to prefix to output when unsandboxed. */
  warning?: string;
 /** When no backend could sandbox the command (fail-closed), a structured
  * description of why — surfaced to the host UI so it can show an actionable
  * banner instead of only the model-facing refusal. */
  unavailable?: SandboxUnavailable;
}

export type SandboxBackend = WrappedCommand["backend"];

/**
 * Structured "no sandbox backend available" descriptor. Carried on a fail-closed
 * WrappedCommand (and mirrored on the session's sandbox status) so a host can
 * render platform-specific install guidance rather than parsing a message.
 */
export interface SandboxUnavailable {
  /** The backend that was attempted/expected for this platform (here "none"). */
  backend: SandboxBackend;
  /** The host platform the probe ran on (`process.platform`). */
  platform: NodeJS.Platform;
  /** One-line actionable guidance for restoring a working sandbox. */
  hint: string;
}

/** Platform-specific guidance for restoring a working OS sandbox backend. */
export function sandboxUnavailableHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "linux":
      return (
        "No OS sandbox backend found. Install bubblewrap (e.g. `apt install bubblewrap`), " +
        "or a Landlock launcher, or set sandbox.mode=\"off\" / sandbox.fallback=\"allow-unsandboxed\"."
      );
    case "win32":
      return (
        "No OS sandbox backend found. CodePilot sandboxes Windows through WSL2 with bubblewrap: " +
        "install WSL2 (`wsl --install`) and bubblewrap inside the default distro " +
        "(`apt install bubblewrap`), or set sandbox.mode=\"off\" / sandbox.fallback=\"allow-unsandboxed\"."
      );
    case "darwin":
      return (
        "sandbox-exec (Seatbelt) was not found at /usr/bin/sandbox-exec. " +
        "Set sandbox.mode=\"off\" or sandbox.fallback=\"allow-unsandboxed\" to override."
      );
    default:
      return (
        `No OS sandbox backend is available on this platform (${platform}). ` +
        "Set sandbox.mode=\"off\" or sandbox.fallback=\"allow-unsandboxed\" to override."
      );
  }
}

/** Build the structured unavailable descriptor for the current platform. */
export function buildSandboxUnavailable(platform: NodeJS.Platform = process.platform): SandboxUnavailable {
  return { backend: "none", platform, hint: sandboxUnavailableHint(platform) };
}

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

let cachedLandlock: string | null | undefined = undefined;

/** Resolve a Landlock launcher binary, or null when none is installed.
 * Landlock is a filesystem-only jail (no network namespace); used as a
 * write-scoping fallback for hosts where user namespaces are disabled. */
export function landlockLauncherPath(): string | null {
  if (cachedLandlock !== undefined) return cachedLandlock;
  if (process.platform !== "linux") {
    cachedLandlock = null;
    return cachedLandlock;
  }
  for (const p of [
    "/usr/bin/codepilot-landlock",
    "/usr/local/bin/codepilot-landlock",
    "/usr/bin/landlock-sandboxer",
    "/usr/local/bin/landlock-sandboxer",
  ]) {
    if (existsSync(p)) {
      cachedLandlock = p;
      return cachedLandlock;
    }
  }
  cachedLandlock = null;
  return cachedLandlock;
}

/** Probe the host for an available sandbox backend. Cached per process.
 * Linux: bwrap first, then Landlock fallback. Windows: WSL2 + bwrap.
 * No backend → "none" (fail-closed). */
export function detectSandboxBackend(): SandboxBackend {
  if (cachedBackend) return cachedBackend;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    cachedBackend = "seatbelt";
  } else if (
    process.platform === "linux" &&
    (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap") || existsSync("/usr/local/bin/bwrap"))
  ) {
    cachedBackend = "bwrap";
  } else if (process.platform === "linux" && landlockLauncherPath()) {
    cachedBackend = "landlock";
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
  cachedSlirp = null;
  cachedLandlock = undefined;
}

let cachedSlirp: string | null | undefined = undefined;

/** Resolve the slirp4netns binary path, or null when it is not installed.
 * slirp4netns gives an `--unshare-net` namespace a userspace network stack so
 * egress can be forced through the loopback allowlist proxy (enforced, not
 * cooperative). Probed the same way as bwrap (fixed install paths) and cached
 * per process. */
export function slirp4netnsPath(): string | null {
  if (cachedSlirp !== undefined) return cachedSlirp;
  if (process.platform !== "linux") {
    cachedSlirp = null;
    return cachedSlirp;
  }
  for (const p of ["/usr/bin/slirp4netns", "/bin/slirp4netns", "/usr/local/bin/slirp4netns"]) {
    if (existsSync(p)) {
      cachedSlirp = p;
      return cachedSlirp;
    }
  }
  cachedSlirp = null;
  return cachedSlirp;
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
 * Build the Seatbelt profile: starts from `(allow default)`, denies writes
 * globally and re-allows writable roots, denies network when off, and denies
 * sensitive reads before the default allow takes effect.
 */
export function buildSeatbeltProfile(policy: ResolvedSandbox): string {
  const lines: string[] = [];
  lines.push("(version 1)");
  lines.push("(allow default)");
  // Network policy: "off" → deny all; "proxy" → deny all then re-allow only
  //    the proxy's loopback port (best-effort without proxy up); "full" →
  //    unrestricted.
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
  // Carve protected metadata (resolved `.git`) back out as read-only, AFTER the
  // writable-root allow so the deny wins for those subpaths. Listed under both
  // the given and realpath'd form (Seatbelt matches resolved paths).
  for (const p of policy.protectedSubpaths) {
    const forms = new Set<string>([p]);
    try {
      forms.add(realpathSync(p));
    } catch {
      /* may not resolve — the literal form still applies */
    }
    for (const form of forms) {
      lines.push(`(deny file-write* (subpath ${JSON.stringify(form)}))`);
    }
  }
 // `>/dev/null`, `2>&1 | tee /dev/stderr` etc. are not real writes.
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") ' +
      '(literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))'
  );
  return lines.join("\n");
}

/** Wrap a command for the given policy. Never throws. */
/** Prefix `export`s routing a sandboxed command's HTTP(S) traffic through the
 * loopback allowlist proxy when a "proxy" policy is active and
 * policy.proxyUrl is set; no-op otherwise. `hostOverride` rewrites the proxy
 * host in the exported URLs (enforced bwrap path reaches the host proxy via
 * the slirp gateway address). */
function withProxyEnv(
  command: string,
  policy: ResolvedSandbox,
  hostOverride?: string,
): string {
  if (policy.networkPolicy.mode !== "proxy" || !policy.proxyUrl) return command;
  let url = policy.proxyUrl;
  if (hostOverride) {
    try {
      const u = new URL(policy.proxyUrl);
      u.hostname = hostOverride;
      url = u.toString().replace(/\/$/, "");
    } catch {
      /* keep the original url if it does not parse */
    }
  }
  const q = shellQuote(url);
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

/** The slirp gateway address: from inside the network namespace this host
 * address NATs to the host's loopback, so the loopback allowlist proxy is
 * reachable here. slirp binds its real-world outbound sockets to host loopback
 * (--outbound-addr=127.0.0.1), so a public IP is unroutable from the namespace
 * — the proxy at this gateway is the only egress that works. */
const SLIRP_GATEWAY = "10.0.2.2";

/**
 * POSIX-shell orchestration: run bwrap --unshare-net under a slirp4netns
 * userspace net stack confined to the loopback proxy. Uses FIFOs to coordinate
 * bwrap's child-pid + block; any setup failure exits non-zero (fail-closed).
 */
function buildSlirpOrchestration(bwrapInnerCmd: string, slirp: string): string {
  const sq = shellQuote;
  // The inner command, wrapped so bwrap blocks it on fd 3 (fed by the block
  // FIFO) until slirp is ready. `read` on fd 3 returns once we write the FIFO.
  const script = [
    `__sb_dir=$(mktemp -d)`,
    `__sb_info="$__sb_dir/info"; __sb_block="$__sb_dir/block"; __sb_ready="$__sb_dir/ready"`,
    `mkfifo "$__sb_info" "$__sb_block" "$__sb_ready"`,
    `__sb_cleanup() { [ -n "$__sb_slirp" ] && kill "$__sb_slirp" 2>/dev/null; rm -rf "$__sb_dir"; }`,
    `trap __sb_cleanup EXIT INT TERM`,
    // bwrap: report child-pid on fd 10 (→info FIFO), block inner cmd on fd 11
    // (←block FIFO). Backgrounded so we can wire slirp to its namespace.
    `${bwrapInnerCmd} 10>"$__sb_info" 11<"$__sb_block" & __sb_bwrap=$!`,
    // Read the namespace child-pid bwrap wrote as JSON {"child-pid":N,...}.
    `__sb_json=$(cat "$__sb_info")`,
    `__sb_pid=$(printf '%s' "$__sb_json" | sed -n 's/.*"child-pid":[ ]*\\([0-9][0-9]*\\).*/\\1/p')`,
    `if [ -z "$__sb_pid" ]; then echo ${sq("[sandbox] enforced-proxy: could not read sandbox pid")} >&2; kill "$__sb_bwrap" 2>/dev/null; exit 126; fi`,
    // Start slirp4netns on that pid; --outbound-addr pins egress to host
    // loopback so nothing but the gateway→proxy path is routable. --ready-fd
    // 3 → ready FIFO signals when tap0 is configured.
    `${sq(slirp)} --configure --mtu=65520 --disable-dns --outbound-addr=127.0.0.1 --ready-fd=3 "$__sb_pid" tap0 3>"$__sb_ready" >/dev/null 2>&1 & __sb_slirp=$!`,
    `if ! read __sb_rc <"$__sb_ready"; then echo ${sq("[sandbox] enforced-proxy: slirp4netns failed to start")} >&2; kill "$__sb_bwrap" 2>/dev/null; exit 126; fi`,
    // Release the inner command now that the network stack is up.
    `: >"$__sb_block"`,
    // Wait for the sandboxed command; propagate its exit status.
    `wait "$__sb_bwrap"; __sb_status=$?`,
    `exit "$__sb_status"`,
  ].join("\n");
  // Run the orchestration in its own sh so the traps/FIFOs are self-contained
  // regardless of the caller's persistent shell state.
  return `/bin/sh -c ${sq(script)}`;
}

/**
 * Environment overlay for non-interactive agents: no pager, no color, dumb
 * terminal, git non-interactive guards. Applied to every command path so none
 * can hang on a pager. Callers overlay this on top of their base env.
 */
export function modelShellEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  out.PAGER = "cat";
  out.GIT_PAGER = "cat";
  out.NO_COLOR = "1";
  out.TERM = "dumb";
  // Never let git drop into an interactive credential/editor prompt that would
  // hang the non-interactive shell.
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

export function wrapCommand(
  command: string,
  policy: ResolvedSandbox,
  opts?: {
    /** Test seam: force the backend instead of probing the host. */
    backend?: SandboxBackend;
    /** Test seam: force the slirp4netns path (or null for "absent"). */
    slirpPath?: string | null;
    /** Test seam: force the Landlock launcher path (or null for "absent"). */
    landlockPath?: string | null;
  },
): WrappedCommand {
  if (policy.mode === "off") {
    return { command, sandboxed: false, backend: "none" };
  }
  const backend = opts?.backend ?? detectSandboxBackend();
  // Enforced-proxy bwrap run: give the namespace a userspace network stack
  // (slirp4netns) confined to the loopback proxy. Fail closed if slirp4netns
  // is unavailable.
  const proxyMode = policy.networkPolicy.mode === "proxy" && !!policy.proxyUrl;
  const slirp =
    proxyMode && backend === "bwrap"
      ? opts?.slirpPath !== undefined
        ? opts.slirpPath
        : slirp4netnsPath()
      : null;
  const enforcedBwrapProxy = proxyMode && backend === "bwrap" && !!slirp;

  // Force child tools through the loopback proxy via env vars (cooperative).
  // The enforced bwrap path injects env inside the namespace instead, so skip
  // the host-loopback export here.
  if (!enforcedBwrapProxy) {
    command = withProxyEnv(command, policy);
  }
  if (backend === "none") {
    const unavailable = buildSandboxUnavailable();
    if (policy.fallback === "allow-unsandboxed") {
      return {
        command,
        sandboxed: false,
        backend: "none",
        warning:
          `[sandbox] WARNING: no OS sandbox available on this host ` +
          `(${process.platform}); command is running UNSANDBOXED. ${unavailable.hint}`,
        unavailable,
      };
    }
    return {
      command: `echo ${shellQuote(
        `[sandbox] denied: sandbox mode "${policy.mode}" is configured but no ` +
          `OS sandbox backend is available on this host. ${unavailable.hint}`
      )} >&2; exit 126`,
      sandboxed: false,
      backend: "none",
      unavailable,
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
  if (backend === "landlock") {
    // Landlock is a filesystem jail only — it cannot create a network
    // namespace. A restricted network policy (proxy/off) fails closed rather
    // than silently running with full egress. Only "full" is served.
    if (proxyMode || !policy.network) {
      const want = proxyMode ? `"proxy"` : `"off"`;
      return {
        command: `echo ${shellQuote(
          `[sandbox] denied: network mode ${want} cannot be enforced under the ` +
            `Landlock backend (a filesystem jail with no network namespace). ` +
            `Install bubblewrap (+ slirp4netns for proxy egress) to restrict the ` +
            `network, or set the network mode to "full".`,
        )} >&2; exit 126`,
        sandboxed: false,
        backend,
      };
    }
    // The launcher grants write access to writable roots; protected metadata
    // (`.git`) inside a root is re-scoped read-only (same carve as bwrap's
    // --ro-bind over the rw bind).
    const launcher =
      opts?.landlockPath !== undefined ? opts.landlockPath : landlockLauncherPath();
    if (!launcher) {
      const unavailable = buildSandboxUnavailable();
      return {
        command: `echo ${shellQuote(
          `[sandbox] denied: the Landlock backend was selected but no launcher ` +
            `is installed. ${unavailable.hint}`,
        )} >&2; exit 126`,
        sandboxed: false,
        backend: "none",
        unavailable,
      };
    }
    const args: string[] = [launcher];
    for (const root of policy.writableRoots) {
      if (existsSync(root)) args.push("--rw", root);
    }
    // Carve protected metadata back out as read-only, AFTER the rw grants so the
    // read-only scope wins for those subpaths (parity with the Seatbelt deny and
    // the bwrap --ro-bind override).
    for (const p of policy.protectedSubpaths) {
      if (existsSync(p)) args.push("--ro", p);
    }
    args.push("--", "/bin/sh", "-c", command);
    return { command: args.map(shellQuote).join(" "), sandboxed: true, backend };
  }
  if (backend === "wsl-bwrap") {
 // Windows path: re-exec the command inside the default WSL distro under
 // bwrap. The Windows cwd is mapped via /mnt/<drive>/...; writable roots
 // are translated the same way. Network restriction uses --unshare-net.
    const wslRoots = policy.writableRoots.map(winPathToWsl);
    const wslCwd = winPathToWsl(policy.writableRoots[0] ?? resolve("/"));
    const args: string[] = ["bwrap", "--unshare-user-try", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    for (const root of wslRoots) {
      args.push("--bind", root, root);
    }
    // Re-bind protected metadata read-only so hooks/config/objects can't be
    // rewritten through an approved shell command.
    for (const p of policy.protectedSubpaths) {
      const wp = winPathToWsl(p);
      args.push("--ro-bind", wp, wp);
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
 // Fail closed: proxy mode without slirp4netns cannot enforce egress — refuse
 // rather than run with full host network.
  if (proxyMode && !slirp) {
    return {
      command: `echo ${shellQuote(
        `[sandbox] denied: network mode "proxy" requires slirp4netns to enforce ` +
          `egress through the loopback proxy on Linux, but slirp4netns is not ` +
          `installed. Install slirp4netns, or set the network mode to "off"/"full".`,
      )} >&2; exit 126`,
      sandboxed: false,
      backend,
    };
  }
  const args: string[] = ["bwrap", "--unshare-user-try", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const root of policy.writableRoots) {
    if (existsSync(root)) args.push("--bind", root, root);
  }
  // Re-bind protected metadata read-only (after the rw binds, so this wins).
  for (const p of policy.protectedSubpaths) {
    if (existsSync(p)) args.push("--ro-bind", p, p);
  }
  if (enforcedBwrapProxy && slirp) {
    // Enforced proxy: isolate the network namespace, attach slirp4netns whose
    // only egress is the loopback proxy. bwrap reports its namespace pid on
    // --info-fd (fd 10) and blocks on --block-fd (fd 11) until tap0 is up.
    const innerCmd = withProxyEnv(command, policy, SLIRP_GATEWAY);
    args.push(
      "--unshare-net",
      "--info-fd",
      "10",
      "--block-fd",
      "11",
      "--",
      "/bin/sh",
      "-c",
      innerCmd,
    );
    const bwrapInner = args.map(shellQuote).join(" ");
    return {
      command: buildSlirpOrchestration(bwrapInner, slirp),
      sandboxed: true,
      backend,
    };
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
