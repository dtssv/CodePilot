import type {
  AgentMode,
  Event,
  ImageAttachment,
  PermissionDecision,
  PromptFile,
  QuestionAnswers,
  SessionSummary,
} from "@codepilot/core";
import type { SessionResumeResult } from "@codepilot/protocol";

import type { ClientRpcHost, ContextReport } from "./clientTypes.js";

export async function newSession(
  host: ClientRpcHost,
  params: {
    cwd?: string;
    model?: string;
    agentMode?: AgentMode;
    systemPromptExtra?: string;
  },
): Promise<string> {
  const { sessionId } = await host.call<{ sessionId: string }>("session/new", params);
  return sessionId;
}

export async function resumeSession(
  host: ClientRpcHost,
  sessionId: string,
  opts?: { readOnly?: boolean; historyLimit?: number },
): Promise<SessionResumeResult> {
  return host.call<SessionResumeResult>("session/resume", {
    sessionId,
    ...(opts?.readOnly ? { readOnly: true } : {}),
    ...(opts?.historyLimit !== undefined ? { historyLimit: opts.historyLimit } : {}),
  });
}

/** Older history page for a resumed session (`before` from a prior resume). */
export async function sessionHistory(
  host: ClientRpcHost,
  sessionId: string,
  before: number,
  limit?: number,
): Promise<{ events: Event[]; historyTruncated: boolean; historyBefore?: number }> {
  return host.call("session/history", {
    sessionId,
    before,
    ...(limit !== undefined ? { limit } : {}),
  });
}

/** Manual compaction (`/compact`): summarise now, keep going on the task. */
export async function sessionCompact(
  host: ClientRpcHost,
  sessionId: string,
  focus?: string,
): Promise<{ ok: true }> {
  return host.call("session/compact", { sessionId, ...(focus ? { focus } : {}) });
}

/** Task boundary (`/clear`): archive context, continue with a clean slate. */
export async function sessionClearContext(
  host: ClientRpcHost,
  sessionId: string,
  reason?: string,
): Promise<{ cleared: boolean }> {
  return host.call("session/clear-context", { sessionId, reason });
}

/** Context-window usage report for the live session: totals + a semantic
 * breakdown (system prompt, skills, tool/MCP schemas, conversation,
 * sub-agents). Used by the context-usage panel. */
export async function sessionContextReport(
  host: ClientRpcHost,
  sessionId: string,
): Promise<ContextReport> {
  return host.call("session/contextReport", { sessionId });
}

/** Exact prompt token count via the server's provider count-tokens API,
 * returned when `context.preciseCount: "on-demand"` and the provider supports
 * it; `null` otherwise. Opt-in only — never a hot path. */
export async function sessionContextCountPrecise(
  host: ClientRpcHost,
  sessionId: string,
): Promise<{ inputTokens: number } | null> {
  return host.call("session/contextCountPrecise", { sessionId });
}

export async function undoSession(
  host: ClientRpcHost,
  sessionId: string,
): Promise<{ restored: string[]; deleted: string[]; label: string }> {
  return host.call("session/undo", { sessionId });
}

export async function redoSession(
  host: ClientRpcHost,
  sessionId: string,
): Promise<{ restored: string[]; deleted: string[]; label: string }> {
  return host.call("session/redo", { sessionId });
}

export async function rewindTargets(
  host: ClientRpcHost,
  sessionId: string,
): Promise<Array<{ messageId: string; text: string; ts?: number }>> {
  return host.call("session/rewindTargets", { sessionId });
}

export async function rewindSession(
  host: ClientRpcHost,
  sessionId: string,
  opts?: { messageId?: string; files?: boolean },
): Promise<{ messageId: string; text: string; turns: number; restored: string[]; deleted: string[] }> {
  return host.call("session/rewind", { sessionId, ...opts });
}

export async function gcSessionArtifacts(
  host: ClientRpcHost,
  sessionId: string,
  dryRun?: boolean,
): Promise<{ removed: number; bytesReclaimed: number; scanned: number; referenced: number }> {
  return host.call("session/gc-artifacts", { sessionId, dryRun });
}

export async function exportSessionTranscript(
  host: ClientRpcHost,
  sessionId: string,
  format?: "markdown" | "jsonl",
): Promise<{ format: "markdown" | "jsonl"; body: string; suggestedName: string }> {
  return host.call("session/export", { sessionId, format });
}

export async function startSessionGoal(
  host: ClientRpcHost,
  sessionId: string,
  objective: string,
  maxRounds?: number,
): Promise<{ accepted: true; running: boolean }> {
  return host.call("session/goal", { sessionId, objective, maxRounds });
}

export async function setPermissionMode(
  host: ClientRpcHost,
  sessionId: string,
  mode: import("@codepilot/core").PermissionMode,
): Promise<{ mode: import("@codepilot/core").PermissionMode }> {
  return host.call("session/setPermissionMode", { sessionId, mode });
}

export async function setPreset(
  host: ClientRpcHost,
  sessionId: string,
  preset: import("@codepilot/core").PermissionPresetName,
): Promise<{
  preset: import("@codepilot/core").PermissionPresetName;
  permissionMode: import("@codepilot/core").PermissionMode;
  sandbox: { mode: string; unavailable?: boolean; backend?: string };
}> {
  return host.call("session/setPreset", { sessionId, preset });
}

export async function describeSessionHooks(
  host: ClientRpcHost,
  sessionId: string,
): Promise<{ text: string }> {
  return host.call("session/describeHooks", { sessionId });
}

export async function describeSessionAgents(
  host: ClientRpcHost,
  opts?: { sessionId?: string; cwd?: string },
): Promise<{ text: string }> {
  return host.call("session/describeAgents", opts ?? {});
}

export async function listTerminalShells(host: ClientRpcHost): Promise<{
  platform: "darwin" | "linux" | "win32" | "other";
  shells: Array<{ id: string; path: string; label: string }>;
}> {
  return host.call("terminal/list-shells", {});
}

export async function openTerminal(
  host: ClientRpcHost,
  opts: {
    shell?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  },
): Promise<{ terminalId: string; shell: string }> {
  return host.call("terminal/open", opts);
}

export async function writeTerminal(host: ClientRpcHost, terminalId: string, data: string): Promise<void> {
  await host.call("terminal/write", { terminalId, data });
}

export async function resizeTerminal(
  host: ClientRpcHost,
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await host.call("terminal/resize", { terminalId, cols, rows });
}

export async function closeTerminal(host: ClientRpcHost, terminalId: string): Promise<void> {
  await host.call("terminal/close", { terminalId });
}

/**
 * List sessions. Pass `cwd` to filter; omit to return every session
 * (client groups them by workspace).
 */
export async function listSessions(host: ClientRpcHost, cwd?: string): Promise<SessionSummary[]> {
  const { sessions } = await host.call<{ sessions: SessionSummary[] }>(
    "session/list",
    cwd ? { cwd } : {},
  );
  return sessions;
}

/** Pin / unpin a session (pin is one-per-workspace, enforced server-side). */
export async function pinSession(host: ClientRpcHost, sessionId: string, pinned: boolean): Promise<void> {
  await host.call("session/pin", { sessionId, pinned });
}

/** Archive / unarchive a session (archived sessions are hidden by default). */
export async function archiveSession(host: ClientRpcHost, sessionId: string, archived: boolean): Promise<void> {
  await host.call("session/archive", { sessionId, archived });
}

export async function send(
  host: ClientRpcHost,
  sessionId: string,
  text: string,
  images?: ImageAttachment[],
  files?: PromptFile[],
  delivery?: "auto" | "queue" | "steer",
): Promise<{ delivery: "started" | "queued" | "steered" }> {
  const params: {
    sessionId: string;
    text: string;
    images?: ImageAttachment[];
    files?: PromptFile[];
    delivery?: "auto" | "queue" | "steer";
  } = {
    sessionId,
    text,
  };
  if (images?.length) params.images = images;
  if (files?.length) params.files = files;
  if (delivery) params.delivery = delivery;
  return host.call("prompt/send", params);
}

export async function removeFollowUp(host: ClientRpcHost, sessionId: string, id: string): Promise<void> {
  await host.call("prompt/followup/remove", { sessionId, id });
}

export async function updateFollowUp(
  host: ClientRpcHost,
  sessionId: string,
  id: string,
  text: string,
): Promise<void> {
  await host.call("prompt/followup/update", { sessionId, id, text });
}

export async function sendFollowUpNow(
  host: ClientRpcHost,
  sessionId: string,
  id: string,
): Promise<{ delivery: "steered" | "started" | "missing" }> {
  return host.call("prompt/followup/sendNow", { sessionId, id });
}

/**
 * Resume the last turn after it ended in an error — re-engage the model where
 * it stopped. `noop` means nothing to resume; the caller should re-send the
 * last prompt.
 */
export async function resumeTurn(
  host: ClientRpcHost,
  sessionId: string,
): Promise<{ delivery: "started" | "queued" | "noop" }> {
  return host.call("prompt/resume", { sessionId });
}

export async function cancel(host: ClientRpcHost, sessionId: string): Promise<void> {
  await host.call("prompt/cancel", { sessionId });
}

export async function setMode(host: ClientRpcHost, sessionId: string, mode: AgentMode): Promise<void> {
  await host.call("session/setMode", { sessionId, mode });
}

export async function setModel(
  host: ClientRpcHost,
  sessionId: string,
  model: string,
  providerId?: string,
  reasoningEffort?: "low" | "medium" | "high" | null,
): Promise<{
  model: string;
  providerId?: string;
  reasoningEffort?: "low" | "medium" | "high";
}> {
  return host.call("session/setModel", {
    sessionId,
    model,
    providerId,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  });
}

export async function getEndpoint(
  host: ClientRpcHost,
  sessionId: string,
): Promise<{
  model: string;
  providerId?: string;
  provider?: string;
  baseURL?: string;
  reasoningEffort?: "low" | "medium" | "high";
}> {
  return host.call("session/getEndpoint", { sessionId });
}

export async function fork(host: ClientRpcHost, sessionId: string, atEventIndex?: number): Promise<string> {
  const { sessionId: forked } = await host.call<{ sessionId: string }>(
    "session/fork",
    { sessionId, atEventIndex },
  );
  return forked;
}

export async function respondPermission(
  host: ClientRpcHost,
  requestId: string,
  decision: PermissionDecision | "abort",
  feedback?: string,
): Promise<void> {
  // Decline-with-feedback: a deny may carry a correction the model sees as
  // the tool result. Only sent on deny with non-empty text. `abort` = "deny &
  // stop": refuse this call and end the whole prompt/turn.
  const params =
    decision === "deny" && feedback && feedback.trim().length > 0
      ? { requestId, decision, feedback: feedback.trim() }
      : { requestId, decision };
  await host.call("permission/respond", params);
}

/** Persisted permission rules for a scope (repo default). */
export async function listPermissions(
  host: ClientRpcHost,
  sessionId: string,
  scope: "repo" | "user" = "repo",
): Promise<{ scope: "repo" | "user"; allow: string[]; ask: string[]; deny: string[] }> {
  return host.call("permissions/list", { sessionId, scope });
}

/** Persist a permission rule and hot-apply it to the live session. */
export async function addPermission(
  host: ClientRpcHost,
  sessionId: string,
  rule: string,
  effect: "allow" | "ask" | "deny",
  scope: "repo" | "user" = "repo",
): Promise<{ path: string }> {
  return host.call("permissions/add", { sessionId, rule, effect, scope });
}

/** Delete a persisted permission rule and hot-apply the removal. */
export async function removePermission(
  host: ClientRpcHost,
  sessionId: string,
  rule: string,
  effect: "allow" | "ask" | "deny",
  scope: "repo" | "user" = "repo",
): Promise<{ removed: boolean }> {
  return host.call("permissions/remove", { sessionId, rule, effect, scope });
}

export async function respondQuestion(
  host: ClientRpcHost,
  requestId: string,
  answers: QuestionAnswers,
): Promise<void> {
  await host.call("question/respond", { requestId, answers });
}