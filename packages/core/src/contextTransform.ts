// Plugin context transform — a source-safe rewrite of the provider message
// view, modelled on pi's `context` event (`transformContext(messages) →
// messages`). A plugin may prune / window / inject-memory into what the model
// sees for a turn, WITHOUT touching the persisted transcript: the transform
// runs on a copy of the already-built provider view, after CodePilot's own
// fold/compaction, and the copy is discarded after the request.
//
// Where pi leaves tool_call↔tool_result pairing to the provider, CodePilot
// validates the returned view and, on ANY problem, falls back to the
// untransformed view (fail-soft — never send a malformed request). This is the
// stricter "report-and-ignore" posture that matches CodePilot's safety stance.

import type { ProviderMessage, ProviderMessageContent } from "./providers/types.js";

/** Result of validating a transformed view. */
export interface ContextTransformCheck {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

const LEGAL_ROLES = new Set(["user", "assistant", "system"]);

/**
 * Validate a plugin-transformed provider view. Rejects (so the caller falls
 * back to the untransformed view) when the result:
 *  - is not a non-empty array,
 *  - contains a message with an illegal role or non-array content,
 *  - drops a `tool_result` for a `tool_use` that is still present, or
 *    introduces a `tool_result` that answers no present `tool_use` — i.e. the
 *    tool_use↔tool_result pairing is broken (providers reject that).
 *
 * Note: this does NOT require the transform to preserve order or all text; a
 * plugin is free to prune/window/inject. It only guards the invariants that
 * would make the provider request invalid.
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
 * transform on a structural copy (so a mutating transform cannot corrupt the
 * caller's array), validates the result, and returns the validated transformed
 * view — or the ORIGINAL view when the transform is absent, throws, or returns
 * an invalid view. `onReject` is called with the reason when a transform is
 * ignored (for an observability warning).
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
