// Session fork and list/search summaries. Extracted from Session (move-only split).

import { stat } from "node:fs/promises";
import type {
  CodepilotConfig,
  Event,
  PermissionResolution,
  PermissionRequest,
  SessionOptions,
  SessionSummary,
} from "../types.js";
import {
  countMessages,
  generateSessionId,
  loadTitleFromDisk,
  sessionPath,
  type RichSessionSummary,
} from "./session-utils.js";

export type ForkHost = {
  id: string;
  cwd: string;
  config: CodepilotConfig;
  model: string;
  systemPromptExtra: SessionOptions["systemPromptExtra"];
  mode: SessionOptions["agentMode"];
  onPermissionRequest?: (
    req: PermissionRequest,
  ) => Promise<PermissionResolution>;
  persisted: Event[];
  events: Event[];
  title: string | null;
  seedForkChild(
    child: import("./session.js").Session,
    slice: Event[],
  ): Promise<void>;
};

/** Returns a short summary of this session for list/search use. */
export async function getSessionSummary(host: ForkHost): Promise<SessionSummary> {
  const path = sessionPath(host.id);
  let updatedAt = Date.now();
  try {
    const st = await stat(path);
    updatedAt = st.mtimeMs;
  } catch {
    /* default */
  }
  const title = host.title ?? (await loadTitleFromDisk(host.id));
  return {
    id: host.id,
    title: title ?? "(untitled)",
    updatedAt,
    cwd: host.cwd,
  };
}

/** Returns an enriched summary including mode/model/messageCount. The
 * base SessionSummary is kept tight for back-compat; callers that want
 * the rich fields use this method. */
export async function getRichSessionSummary(
  host: ForkHost,
): Promise<RichSessionSummary> {
  const base = await getSessionSummary(host);
  return {
    ...base,
    mode: host.mode,
    model: host.model,
    messageCount: countMessages(host.events),
  };
}

/**
 * Create a new session seeded with this session's history.
 *
 * By default the fork copies `host.events` — the MODEL-FACING view, which
 * after a compaction starts at the latest summary and omits the archived
 * pre-compaction turns. That is the right default: the fork continues from
 * the same context the parent currently has, not re-inflated history the
 * parent itself already dropped.
 *
 * Pass `{ fullHistory: true }` to instead copy `host.persisted` — the
 * complete append-only log, including everything before the last compaction.
 * Use this when the fork must be able to replay the full original trajectory
 * (e.g. audit / branch-from-arbitrary-point). `atEventIndex` slices whichever
 * source is selected.
 */
export async function forkSession(
  host: ForkHost,
  atEventIndex?: number,
  opts?: { fullHistory?: boolean },
): Promise<import("./session.js").Session> {
  const newId = generateSessionId();
  const { Session } = await import("./session.js");
  const forked = new Session(newId, {
    cwd: host.cwd,
    config: host.config,
    model: host.model,
    systemPromptExtra: host.systemPromptExtra,
    agentMode: host.mode,
    onPermissionRequest: host.onPermissionRequest,
  });
  await forked.init();
  const source = opts?.fullHistory ? host.persisted : host.events;
  const slice =
    atEventIndex === undefined ? source : source.slice(0, atEventIndex);
  await host.seedForkChild(forked, slice);
  return forked;
}