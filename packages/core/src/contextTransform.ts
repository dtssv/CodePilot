// Plugin context transform: a source-safe rewrite of the provider message
// view. A plugin may prune / window / inject-memory into what the model sees
// for a turn without touching the persisted transcript — the transform runs
// on a copy (after fold/compaction), discarded after the request. The result
// is validated; on any problem it falls back to the untransformed view.

import type { ProviderMessage, ProviderMessageContent } from "./providers/types.js";

/** Result of validating a transformed view. */
export interface ContextTransformCheck {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

const LEGAL_ROLES = new Set(["user", "assistant", "system"]);

/**
 * Validate a plugin-transformed provider view. Rejects (falling back to the
 * untransformed view) when not a non-empty array, has an illegal role/non-array
 * content, or breaks the tool_use↔tool_result pairing. Does NOT require order/text.
 */
export function validateTransformedView(
  view: unknown,
): ContextTransformCheck {
  if (!Array.isArray(view) || view.length === 0) {
    return { ok: false, reason: "transform returned an empty or non-array view" };
  }
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of view as ProviderMessage[]) {
    if (!msg || typeof msg !== "object") {
      return { ok: false, reason: "a message is not an object" };
    }
    if (!LEGAL_ROLES.has(msg.role)) {
      return { ok: false, reason: `illegal role: ${String(msg.role)}` };
    }
    if (!Array.isArray(msg.content)) {
      return { ok: false, reason: "a message has non-array content" };
    }
    for (const part of msg.content as ProviderMessageContent[]) {
      if (!part || typeof part !== "object" || typeof part.type !== "string") {
        return { ok: false, reason: "a content block is malformed" };
      }
      if (part.type === "tool_use") toolUseIds.add(part.id);
      else if (part.type === "tool_result") toolResultIds.add(part.toolCallId);
    }
  }
  // Every tool_use kept must still have its tool_result, and every tool_result
  // kept must still answer a present tool_use. A plugin that drops one half of
  // a pair produces a request the provider will reject.
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      return { ok: false, reason: `tool_use ${id} has no matching tool_result` };
    }
  }
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) {
      return { ok: false, reason: `tool_result ${id} answers no present tool_use` };
    }
  }
  return { ok: true };
}

/**
 * Apply a plugin context transform to a provider view, fail-soft. Runs the
 * transform on a structural copy, validates it, returns the transformed view —
 * or the ORIGINAL when absent/throwing/invalid (`onReject` gets the reason).
 */
export function applyContextTransform(
  view: ProviderMessage[],
  transform: ((view: ProviderMessage[]) => ProviderMessage[]) | undefined,
  onReject?: (reason: string) => void,
): ProviderMessage[] {
  if (!transform) return view;
  let next: ProviderMessage[];
  try {
    // structuredClone keeps the transform from mutating the live view even if
    // it edits in place and returns the same reference.
    next = transform(structuredClone(view));
  } catch (err) {
    onReject?.(`context transform threw: ${(err as Error).message}`);
    return view;
  }
  const check = validateTransformedView(next);
  if (!check.ok) {
    onReject?.(`context transform produced an invalid view: ${check.reason}`);
    return view;
  }
  return next;
}
