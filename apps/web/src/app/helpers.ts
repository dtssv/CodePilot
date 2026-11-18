import type { CodepilotClient } from "../protocol/client.js";
import { t } from "../i18n.js";
import type { Codepilot } from "../state/useCodepilot.js";
import type { Row } from "../state/rows.js";
import { parseReference } from "../state/paths.js";

export async function pickWorkspaceViaSystem(cp: Codepilot): Promise<string | null> {
  if (window.codepilotDesktop) {
    return window.codepilotDesktop.pickFolder();
  }
  try {
    const result = await cp.client.pickFolder();
    if (result.path) return result.path;
    if (!result.supported) {
      cp.notify(t("System folder picker is not available on this host"));
    }
    return null;
  } catch (err) {
    cp.notify(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function scrollSignature(rows: Row[]): string {
  const last = rows[rows.length - 1];
  const tail = last?.kind === "message" ? last.msg.text.length : last?.kind === "tool" ? last.tool.status : "";
  return `${rows.length}:${tail}`;
}

/** Last one or two path segments, for compact workspace/session hints. */
export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

/** Full-page connect form only when we have nothing to try with. A URL with
 * `?token=` (or a remembered url+token) skips straight into the main shell
 * while the handshake runs; a failed / stale token just shows the notice
 * there — open the new serve link to replace it. */
export function needsConnectScreen(cp: Codepilot, canBootstrap: boolean): boolean {
  const s = cp.state;
  if (s.connection === "connected" || s.connection === "connecting") return false;
  if (s.reconnectAttempt !== undefined) return false;
  if (canBootstrap) return false;
  return true;
}

export const CHAT_SUGGESTIONS = [
  "Explain the architecture of this project",
  "Find potential bugs in the recent changes",
  "Write unit tests for the most complex module",
];

export function joinPath(cwd: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

/** Open a (possibly bare/relative) referenced path in the host editor. Resolves
 * it through the server's workspace fallback first so a bare name like
 * "subagent.ts" opens the real file instead of joining to the wrong root and
 * failing with "Failed to open path". Falls back to a plain join if the
 * resolve RPC is unavailable. Strips a trailing `:line[:col]` anchor first. */
export async function openResolvedPath(
  client: CodepilotClient,
  cwd: string,
  rawPath: string,
): Promise<void> {
  const path = parseReference(rawPath).path;
  let abs = joinPath(cwd, path);
  try {
    const r = await client.resolveWorkspace(path, cwd);
    if (r.absolute) abs = r.absolute;
  } catch {
    /* resolve unavailable → use the join fallback */
  }
  window.codepilotDesktop?.openPath(abs);
}
