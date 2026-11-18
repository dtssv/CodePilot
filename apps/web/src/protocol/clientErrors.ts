import { RpcError } from "@codepilot/protocol/rpc";

/**
 * Build the WebSocket URL. The token travels as a query parameter because a
 * browser cannot set headers on a WebSocket handshake.
 */
export function buildUrl(url: string, token?: string): string {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("token", token);
  return u.toString();
}

/**
 * Split a pasted `codepilot serve --web` URL into its parts, so the user can
 * paste the line the CLI printed instead of filling two fields.
 */
export function parseServeUrl(input: string): { url: string; token?: string } {
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    const token = u.searchParams.get("token") ?? undefined;
    u.searchParams.delete("token");
 // `URL` keeps a trailing "?" once the only param is removed.
    return { url: u.toString().replace(/\?$/, ""), token };
  } catch {
    return { url: trimmed };
  }
}

/** Owner payload on a SESSION_LOCKED (−32002) error, when present. */
export interface SessionLockOwnerInfo {
  pid: number;
  acquiredAt?: number;
  host?: string;
  url?: string;
  token?: string;
}

/** Extract SESSION_LOCKED owner info, or null when the error is something else. */
export function sessionLockedOwner(err: unknown): SessionLockOwnerInfo | null {
  if (!(err instanceof RpcError) || err.code !== -32002) return null;
  const data = err.data as { owner?: Partial<SessionLockOwnerInfo> } | undefined;
  const owner = data?.owner;
  if (!owner || typeof owner.pid !== "number") return null;
  return {
    pid: owner.pid,
    ...(typeof owner.acquiredAt === "number" ? { acquiredAt: owner.acquiredAt } : {}),
    ...(owner.host ? { host: owner.host } : {}),
    ...(owner.url ? { url: owner.url } : {}),
    ...(owner.token ? { token: owner.token } : {}),
  };
}

/** Human-readable message for an RPC failure. */
export function describeError(err: unknown): string {
  if (err instanceof RpcError) {
 // -32000 is SessionNotFound: the common case after a server restart, and
 // "session not found" alone does not tell the user what to do about it.
    if (err.code === -32000) {
      return `${err.message} — the server may have restarted; pick or start another session`;
    }
    if (err.code === -32002) {
      const owner = sessionLockedOwner(err);
      if (owner?.url) {
        return `Session is open on another CodePilot (pid ${owner.pid}) — attaching to that daemon…`;
      }
      return (
        `Session is in use by another process (pid ${owner?.pid ?? "?"}). ` +
        `Open it read-only, or close the other client and try again.`
      );
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}