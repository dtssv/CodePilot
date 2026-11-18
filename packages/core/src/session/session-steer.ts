// Mid-run steering and follow-up queue. Extracted from Session (move-only split).

import { randomUUID } from "node:crypto";
import type { Event, FollowUpItem, ImageAttachment, PromptFile } from "../types.js";

/** A queued mid-run steering message. See `steeringQueue`. */
export interface SteeringItem {
  source: "user" | "system";
  text: string;
  delivery: "steer" | "followup";
}

export type SteerHost = {
  disposed: boolean;
  drainingFollowUps: boolean;
  steeringQueue: SteeringItem[];
  steerController: AbortController | null;
  followUpQueue: FollowUpItem[];
  isBusy(): boolean;
  prompt(text: string, images?: ImageAttachment[], files?: PromptFile[]): Promise<void>;
  notify(e: Event): void;
};

/**
 * Queue a mid-run steering message. It is injected as a user message as soon
 * as the agent reaches an injection boundary — mid-stream before any tool call
 * starts, or right after the current tool batch — rather than waiting for the
 * next top-level turn. To make the mid-stream boundary reachable immediately,
 * this aborts only the in-flight provider stream (never the whole run), so any
 * text already generated is kept and the model re-samples with the correction
 * in view. Safe to call while a prompt is running or idle; messages queued
 * while idle are prepended to the next prompt's transcript.
 */
export function steer(host: SteerHost, text: string): void {
  if (text.trim().length === 0) return;
  host.steeringQueue.push({ source: "user", text, delivery: "steer" });
  // Wake the stream so the correction lands this turn, not the next one.
  // Harmless when idle (a fresh controller is created on the next prompt).
  host.steerController?.abort();
}

/** Snapshot of prompts waiting to run after the current busy turn. */
export function listFollowUps(host: SteerHost): FollowUpItem[] {
  return host.followUpQueue.map((item) => ({ ...item }));
}

/**
 * Enqueue a prompt to run after the current busy turn. Emits a `followup`
 * event for UIs. Safe while idle too (will drain on the next `finally`).
 */
export function enqueueFollowUp(
  host: SteerHost,
  opts: {
    text: string;
    images?: ImageAttachment[];
    files?: PromptFile[];
  },
): FollowUpItem {
  const item: FollowUpItem = {
    id: `fu_${randomUUID().slice(0, 8)}`,
    text: opts.text,
    images: opts.images,
    files: opts.files,
    queuedAt: Date.now(),
  };
  host.followUpQueue.push(item);
  emitFollowUp(host, "queued");
  return item;
}

/** Remove one queued follow-up by id. Returns true if it was present. */
export function removeFollowUp(host: SteerHost, id: string): boolean {
  const before = host.followUpQueue.length;
  host.followUpQueue = host.followUpQueue.filter((item) => item.id !== id);
  if (host.followUpQueue.length === before) return false;
  emitFollowUp(host, "removed");
  return true;
}

/** Replace the text of a queued follow-up. Returns true if it was present. */
export function updateFollowUp(host: SteerHost, id: string, text: string): boolean {
  const item = host.followUpQueue.find((x) => x.id === id);
  if (!item) return false;
  item.text = text;
  emitFollowUp(host, "updated");
  return true;
}

/**
 * Take a queued follow-up and inject it into the current run (steer),
 * without cancelling. Text-only: attachments on the queued item are dropped
 * with a short note. When idle, starts a normal prompt (attachments kept).
 */
export function sendFollowUpNow(host: SteerHost, id: string): "steered" | "started" | false {
  const idx = host.followUpQueue.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  const [item] = host.followUpQueue.splice(idx, 1);
  if (!item) return false;
  emitFollowUp(host, "removed");

  if (host.isBusy()) {
    let text = item.text;
    if ((item.images?.length ?? 0) > 0 || (item.files?.length ?? 0) > 0) {
      text =
        `${text.trim()}\n\n[note: queued attachments were not injected into the ` +
        `current run — re-attach them if still needed.]`;
    }
    steer(host, text);
    return "steered";
  }

  void host.prompt(item.text, item.images, item.files);
  return "started";
}

/** Drop every queued follow-up. */
export function clearFollowUps(host: SteerHost): void {
  if (host.followUpQueue.length === 0) return;
  host.followUpQueue = [];
  emitFollowUp(host, "cleared");
}

export function emitFollowUp(
  host: SteerHost,
  action: "queued" | "removed" | "cleared" | "started" | "updated",
): void {
  const ev: Event = {
    type: "followup",
    action,
    items: listFollowUps(host),
  };
  host.notify(ev);
}

/**
 * Start the next follow-up if idle. Called from `prompt()`'s finally and
 * after remove/clear when appropriate. Never overlaps a busy run.
 */
export async function drainFollowUps(host: SteerHost): Promise<void> {
  if (host.disposed || host.drainingFollowUps || host.isBusy()) return;
  if (host.followUpQueue.length === 0) return;
  host.drainingFollowUps = true;
  try {
    while (!host.disposed && !host.isBusy() && host.followUpQueue.length > 0) {
      const next = host.followUpQueue.shift()!;
      emitFollowUp(host, "started");
      await host.prompt(next.text, next.images, next.files);
    }
  } finally {
    host.drainingFollowUps = false;
  }
}

/**
 * Queue an engine-generated notice for the model's next turn. Unlike
 * {@link steer}, this is NOT persisted as a user message: it rides in the
 * per-turn runtime_context (like the plan-stall notice), so a system
 * notice can never be mistaken for — or impersonate — human input. Used
 * for background-job completion and similar out-of-band events.
 */
export function steerSystem(host: SteerHost, text: string): void {
  if (text.trim().length === 0) return;
  host.steeringQueue.push({ source: "system", text, delivery: "steer" });
}