// Durable session inbox: pending steers + follow-ups survive process restart.
// Sidecar next to the JSONL (not in the event log) so UI queue edits stay cheap
// and we do not append control noise to the transcript. 
// SessionInbox persistence model without requiring a DB.

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FollowUpItem } from "../types.js";
import type { SteeringItem } from "./session-steer.js";
import { inboxSidecarPath } from "./sessionPaths.js";

export interface SessionInboxState {
  version: 1;
  steering: SteeringItem[];
  followUps: FollowUpItem[];
}

const EMPTY: SessionInboxState = { version: 1, steering: [], followUps: [] };

export { inboxSidecarPath };

/** Load pending steers/follow-ups. Missing/corrupt → empty. System steers are
 * dropped on load (they are ephemeral runtime notices). */
export async function loadSessionInbox(id: string): Promise<SessionInboxState> {
  try {
    const raw = await readFile(inboxSidecarPath(id), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionInboxState>;
    const steering = Array.isArray(parsed.steering)
      ? parsed.steering.filter(
          (i): i is SteeringItem =>
            !!i &&
            typeof i === "object" &&
            (i.source === "user" || i.source === "system") &&
            typeof i.text === "string" &&
            (i.delivery === "steer" || i.delivery === "followup"),
        )
      : [];
    const followUps = Array.isArray(parsed.followUps)
      ? parsed.followUps.filter(
          (i): i is FollowUpItem =>
            !!i &&
            typeof i === "object" &&
            typeof i.id === "string" &&
            typeof i.text === "string" &&
            typeof i.queuedAt === "number",
        )
      : [];
    return {
      version: 1,
      // System notices are per-turn ephemeral — do not revive after restart.
      steering: steering.filter((i) => i.source === "user"),
      followUps,
    };
  } catch {
    return { ...EMPTY, steering: [], followUps: [] };
  }
}

/** Persist pending user steers + follow-ups. Empty inbox removes the sidecar. */
export async function saveSessionInbox(
  id: string,
  state: { steering: SteeringItem[]; followUps: FollowUpItem[] },
): Promise<void> {
  const path = inboxSidecarPath(id);
  const steering = state.steering.filter((i) => i.source === "user" && i.text.trim().length > 0);
  const followUps = state.followUps.filter((i) => i.text.trim().length > 0);
  if (steering.length === 0 && followUps.length === 0) {
    try {
      await unlink(path);
    } catch {
      /* missing is fine */
    }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const body: SessionInboxState = { version: 1, steering, followUps };
  await writeFile(path, `${JSON.stringify(body)}\n`, "utf-8");
}

export async function clearSessionInbox(id: string): Promise<void> {
  try {
    await unlink(inboxSidecarPath(id));
  } catch {
    /* ignore */
  }
}
