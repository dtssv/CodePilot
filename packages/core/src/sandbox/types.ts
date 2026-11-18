// OS-level sandboxing for tool execution. Two layers driven by one
// SandboxConfig: process layer (bash via sandbox-exec/bwrap/WSL) and tool
// layer (assertPathAllowed validates paths before I/O). Pure Node;
// dependency-free; never throws from detection.

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
 /** CodePilot's own control files (settings, trust stores, plugins, the
  * installed binary, daemon credentials), carved out read-only. `~/.codepilot`
  * is a writable root for project state, so without this a jailed command
  * could widen its own permissions or plant a plugin for the next session. */
  controlPaths?: string[];
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
 * Max extra writable roots listed in the prompt. Defaults (cwd / OS temp /
 * ~/.codepilot) are described in prose and never enumerated — listing every
 * temp symlink variant bloated the prompt without helping the model.
 */
export const SANDBOX_PROMPT_EXTRA_ROOTS_CAP = 8;

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

export interface ShellEnvOptions {
  /** Withhold secret-looking variables (KEY/SECRET/TOKEN/…). Default false. */
  excludeSecrets?: boolean;
  /** Names or `*` globs still forwarded when `excludeSecrets` is on. */
  passthrough?: string[];
}

export interface PathCheckResult {
  ok: boolean;
  reason?: string;
}

export interface DangerCheck {
  dangerous: boolean;
  why?: string;
}