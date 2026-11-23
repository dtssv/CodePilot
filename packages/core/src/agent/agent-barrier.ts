// Abort detection + read/write concurrency barrier for a turn's tool calls.

import type { PermissionLevel } from "../tools/types.js";
import type { ToolExecResult } from "./agent-tools.js";

/** True when a thrown value is a user/system abort (DOMException or Node). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string; code?: string };
  if (e.name === "AbortError") return true;
  if (e.code === "ABORT_ERR") return true;
  return isAbortMessage(e.message ?? "");
}

/** Match AbortError messages across runtimes (Node undici / browsers). */
export function isAbortMessage(message: string): boolean {
  return (
    /this operation was aborted/i.test(message) ||
    /^aborted$/i.test(message.trim()) ||
    /the operation was aborted/i.test(message)
  );
}

/**
 * Whether a tool can run concurrently with others in the same turn based on
 * its permission tier alone. Read-only and network tools parallelize;
 * write/execute tools serialize. Fail-closed: unknown permission is NOT
 * parallel-safe. Prefer {@link ToolDef.concurrencySafe} when a tool can prove
 * a specific call is read-only (e.g. `git status`).
 */
export function isParallelSafeTool(permission: PermissionLevel | undefined): boolean {
  return permission === "read" || permission === "network";
}

/** Result stub for tool calls skipped because a mid-run steer arrived. */
const STEER_SKIPPED_RESULT: ToolExecResult = {
  content:
    "[interrupted: a user message was injected before this tool started, so it had no effect. " +
    "It is safe to re-issue the call if still needed.]",
  isError: true,
};

/**
 * Execute a turn's tool calls with a read/write barrier, returning results in
 * original call order. Reads parallelize, writes serialize.
 *
 * `shouldPause`: checked between batches after the first; when true the rest are
 * marked interrupted, so a mid-tools steer lands at the next turn boundary
 * sooner. Callers gate out steers that were already pending when tools began.
 */
export async function runToolsWithBarrier<T>(
  calls: readonly T[],
  isParallelSafe: (call: T) => boolean,
  run: (call: T) => Promise<ToolExecResult>,
  opts?: { shouldPause?: () => boolean },
): Promise<ToolExecResult[]> {
  const results = new Array<ToolExecResult>(calls.length);
  let i = 0;
  let finishedBatch = false;
  while (i < calls.length) {
    if (finishedBatch && opts?.shouldPause?.()) {
      for (; i < calls.length; i++) results[i] = { ...STEER_SKIPPED_RESULT };
      break;
    }
    if (isParallelSafe(calls[i]!)) {
      // Gather the maximal run of adjacent parallel-safe calls and run them
      // together; a mutating call (or the end) closes the batch.
      const start = i;
      while (i < calls.length && isParallelSafe(calls[i]!)) i++;
      const batch = await Promise.all(calls.slice(start, i).map((c) => run(c)));
      for (let j = 0; j < batch.length; j++) results[start + j] = batch[j]!;
    } else {
      // Exclusive: nothing else runs while this mutating call is in flight.
      results[i] = await run(calls[i]!);
      i++;
    }
    finishedBatch = true;
  }
  return results;
}
