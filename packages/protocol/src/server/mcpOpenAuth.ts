import type { ServerContext } from "./context.js";
import { liveSessions } from "./liveSessions.js";

export type McpOauthState = "idle" | "pending" | "authorized" | "error";

export interface McpOauthEntry {
  state: McpOauthState;
  url?: string;
  error?: string;
  running?: Promise<void>;
}

/** Process-wide MCP OAuth status so Settings can poll across connections. */
export const mcpOauthByName = new Map<string, McpOauthEntry>();

export function notifyMcpOauthRequired(name: string, url: string): void {
  for (const live of liveSessions.values()) {
    for (const holder of live.holders) {
      void holder.peer
        .notify<{ name: string; url: string }>("mcp/oauth-required", { name, url })
        .catch(() => {});
    }
  }
}

export function makeMcpOpenAuthUrl(ctx: ServerContext): (serverName: string, url: string) => Promise<void> {
  return async (serverName, url) => {
    const prev = mcpOauthByName.get(serverName);
    mcpOauthByName.set(serverName, {
      state: "pending",
      url,
      error: undefined,
      running: prev?.running,
    });
    void ctx.peer
      .notify<{ name: string; url: string }>("mcp/oauth-required", { name: serverName, url })
      .catch(() => {});
    notifyMcpOauthRequired(serverName, url);
  };
}