// OS-level sandboxing for tool execution. Two layers driven by one
// SandboxConfig: process layer (bash via sandbox-exec/bwrap/WSL) and tool
// layer (assertPathAllowed validates paths before I/O). Pure Node;
// dependency-free; never throws from detection.

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import type { ResolvedSandbox, SandboxBackend, WrappedCommand, ShellEnvOptions } from "./types.js";
import {
  buildSandboxUnavailable,
  detectSandboxBackend,
  landlockLauncherPath,
  slirp4netnsPath,
} from "./backend.js";
import { networkDenied, SENSITIVE_READ_PATHS } from "./policy.js";

// ---------------------------------------------------------------------------
// Layer 1: process sandbox for bash
// ---------------------------------------------------------------------------

/** Roots to mount read-write. A root that does not exist yet is mounted
 * through its nearest existing ancestor, so the sandboxed process can create
 * it: bwrap refuses to bind a source that is absent. A root whose only existing
 * ancestor is the filesystem root is dropped — binding `/` read-write would
 * hand the whole host to the sandboxed command. */
function bindableRoots(roots: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    let candidate = root;
    while (!existsSync(candidate)) {
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    if (candidate === parse(candidate).root) continue;
    out.add(candidate);
  }
  return [...out];
}

export function shellQuote(s: string): string {
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
  //    the proxy's loopback port (deny all while no proxy is up); "full" →
  //    unrestricted.
  if (networkDenied(policy)) {
    lines.push("(deny network*)");
  } else if (policy.networkPolicy.mode === "proxy") {
    const port = proxyPort(policy.proxyUrl!);
    lines.push("(deny network*)");
    if (port) lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
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
  for (const p of [...policy.protectedSubpaths, ...(policy.controlPaths ?? [])]) {
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

/** Env var names that look like credentials (case-insensitive substring). */
const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i;

function envGlob(pattern: string): RegExp {
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

/** Whether a model-run shell may see `name` under `opts`. */
export function shellEnvAllowed(name: string, opts?: ShellEnvOptions): boolean {
  if (!opts?.excludeSecrets || !SECRET_ENV_NAME.test(name)) return true;
  return (opts.passthrough ?? []).some((p) => envGlob(p).test(name));
}

export function modelShellEnv(base: NodeJS.ProcessEnv = process.env, opts?: ShellEnvOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && shellEnvAllowed(k, opts)) out[k] = v;
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
    if (proxyMode || networkDenied(policy)) {
      const want = `"${policy.networkPolicy.mode}"`;
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
    for (const root of bindableRoots(policy.writableRoots)) {
      args.push("--rw", root);
    }
    // Carve protected metadata back out as read-only, AFTER the rw grants so the
    // read-only scope wins for those subpaths (parity with the Seatbelt deny and
    // the bwrap --ro-bind override).
    for (const p of [...policy.protectedSubpaths, ...(policy.controlPaths ?? [])]) {
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
    for (const p of policy.controlPaths ?? []) {
      if (existsSync(p)) {
        const wp = winPathToWsl(p);
        args.push("--ro-bind", wp, wp);
      }
    }
    args.push(...bwrapSensitiveMasks(SENSITIVE_READ_PATHS, winPathToWsl));
    if (networkDenied(policy)) args.push("--unshare-net");
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
  for (const root of bindableRoots(policy.writableRoots)) {
    args.push("--bind", root, root);
  }
  // Re-bind protected metadata read-only (after the rw binds, so this wins).
  for (const p of [...policy.protectedSubpaths, ...(policy.controlPaths ?? [])]) {
    if (existsSync(p)) args.push("--ro-bind", p, p);
  }
  args.push(...bwrapSensitiveMasks());
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
  if (networkDenied(policy)) args.push("--unshare-net");
  args.push("--", "/bin/sh", "-c", command);
  const bwrapCmd = args.map(shellQuote).join(" ");
  return { command: bwrapCmd, sandboxed: true, backend };
}

/**
 * bwrap args that hide `SENSITIVE_READ_PATHS` inside the jail (parity with the
 * Seatbelt read denies): a directory is covered by an empty tmpfs, a file by
 * /dev/null. Must follow the rw binds so the mask wins over a writable root
 * that contains it. `toJail` maps a host path to its in-jail path (WSL).
 */
export function bwrapSensitiveMasks(
  paths: string[] = SENSITIVE_READ_PATHS,
  toJail: (p: string) => string = (p) => p,
): string[] {
  const args: string[] = [];
  for (const p of paths) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    const jp = toJail(p);
    if (st.isDirectory()) args.push("--tmpfs", jp);
    else args.push("--ro-bind", "/dev/null", jp);
  }
  return args;
}

/** Translate a Windows path (C:\foo\bar) to its WSL mount (/mnt/c/foo/bar). */
export function winPathToWsl(p: string): string {
  const m = p.match(/^([A-Za-z]):[\\\/](.*)$/);
  if (!m) return p.replace(/\\/g, "/");
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
}
