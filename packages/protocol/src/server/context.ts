import { relative, resolve } from "node:path";
import type { FSWatcher } from "node:fs";
import type { AgentMode, PermissionMode, RemoteGrant, Session } from "@codepilot/core";
import { normalizeCwd } from "@codepilot/core";
import { parseReference } from "../paths.js";
import { ErrorCode, Peer, RpcError } from "../rpc.js";
import type { TerminalHost } from "../terminalHost.js";

/** Capability set advertised by {@link registerServer} on initialize. */
export type ServerCapabilities = {
  tools: string[];
  providers: string[];
  modes: AgentMode[];
  config?: boolean;
  setModel?: boolean;
  workspacePick?: boolean;
  remoteControl?: boolean;
  git?: boolean;
};

export interface ServerContext {
  peer: Peer;
  sessions: Map<string, Session>;
  defaultCwd: string;
  defaultPermissionMode: PermissionMode;
  capabilities: ServerCapabilities;
  initialized: boolean;
  /** At most one workspace watcher per connection (re-watch replaces). */
  watcher?: {
    watcher: FSWatcher;
    debounce?: ReturnType<typeof setTimeout>;
    kinds: Set<"rename" | "change">;
    path: string;
  };
  /** Per-connection event subscriptions, keyed by session id. Each client
   * connection subscribes independently so several clients can follow the
   * same live session at once (and a reconnect re-subscribes cleanly). */
  sessionSubs: Map<string, () => void>;
  /** Goal loops requested by the model (via `start_goal`) but not yet started,
   * keyed by session id. A pending entry is consumed when the triggering turn
   * settles (`status: idle`), at which point `driveGoalRounds` takes over. */
  pendingGoals: Map<string, { objective: string; maxRounds?: number }>;
  /** Session ids with a goal loop currently driving, so the idle-watcher does
   * not re-trigger on the per-round idle events the loop itself produces. */
  activeGoalLoops: Set<string>;
  /** Present when this connection authenticated via QR remote grant. */
  remoteGrant?: RemoteGrant;
  /** Daemon identity recorded in each session's write-lease lock file so a
   * second opener can be redirected to attach here. */
  lockIdentity?: { host?: string; url?: string; token?: string };
  /** Interactive PTYs owned by this connection. */
  terminals: TerminalHost;
  /** In-flight inline completions keyed by the client's opaque requestId, so a
   * `completion/cancel` notification can abort the upstream model call instead
   * of letting a discarded completion keep burning tokens. */
  completionAborts: Map<string, AbortController>;
}

export const WORKSPACE_MAX_BYTES = 512 * 1024;

export function assertInitialized(ctx: ServerContext): void {
  if (!ctx.initialized) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      "initialize must be called first",
    );
  }
}

export function requireSession(ctx: ServerContext, sessionId: string): Session {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    throw new RpcError(ErrorCode.SessionNotFound, `unknown session: ${sessionId}`);
  }
  return session;
}

/** Normalized set of workspaces a remote grant authorizes. */
export function grantAllowedCwds(grant: RemoteGrant): Set<string> {
  const list = grant.cwds && grant.cwds.length > 0 ? grant.cwds : [grant.cwd];
  return new Set(list.filter((c): c is string => !!c).map((c) => normalizeCwd(c)));
}

/**
 * Enforce that a scoped remote grant may only act on an authorized workspace
 * (no-op for local). Checked at every cwd entry point, not just `session/list`,
 * so a remote client can't target an arbitrary directory outside its grant.
 */
export function assertCwdInGrantScope(ctx: ServerContext, cwd: string | undefined): void {
  const grant = ctx.remoteGrant;
  if (!grant) return;
  if (!cwd || typeof cwd !== "string" || !cwd.trim()) return;
  const allowed = grantAllowedCwds(grant);
  if (!allowed.has(normalizeCwd(cwd))) {
    throw new RpcError(
      ErrorCode.InvalidRequest,
      "Remote grant does not authorize this workspace",
    );
  }
}

export function workspacePath(
  ctx: ServerContext,
  input: string | undefined,
  cwd?: string,
): { abs: string; rel: string } {
  // Strip trailing `:line[:col]` (grep / model cites) so open/read never treat
  // `foo.ts:79` as a literal filename.
  const rel = input ? parseReference(input).path : ".";
  // A remote grant may only read/list against an authorized workspace root.
  assertCwdInGrantScope(ctx, cwd);
  // Prefer an explicit workspace root (the folder the client has open) over
  // the daemon's process cwd, so file/folder paths resolve against the active
  // workspace in multi-workspace setups.
  const root = cwd && cwd.trim() ? resolve(cwd) : resolve(ctx.defaultCwd);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new RpcError(ErrorCode.InvalidRequest, "workspace path escapes cwd");
  }
  return { abs, rel: relative(root, abs) || "." };
}

/** Resolve the git working directory: explicit workspace cwd over daemon cwd.
 * Also enforces the remote-grant scope — git RPCs can read and mutate a repo,
 * so a scoped phone must not run them against an unauthorized workspace. */
export function gitCwd(ctx: ServerContext, cwd?: string): string {
  assertCwdInGrantScope(ctx, cwd);
  return cwd && cwd.trim() ? resolve(cwd) : resolve(ctx.defaultCwd);
}