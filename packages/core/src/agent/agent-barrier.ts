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
 * Whether a tool can run concurrently with others in the same turn. Read-only
 * and network tools parallelize; write/execute tools serialize. Fail-closed:
 * unknown permission is NOT parallel-safe.
 */
export function isParallelSafeTool(permission: PermissionLevel | undefined): boolean {
  return permission === "read" || permission === "network";
}

/**
 * Execute a turn's tool calls with a read/write concurrency barrier, returning
 * results in original call order. Adjacent parallel-safe calls run concurrently;
 * mutating calls run exclusively. Reads parallelize, writes serialize.
 */
export async function runToolsWithBarrier<T>(
  calls: readonly T[],
  isParallelSafe: (call: T) => boolean,
  run: (call: T) => Promise<ToolExecResult>,
): Promise<ToolExecResult[]> {
  const results = new Array<ToolExecResult>(calls.length);
  let i = 0;
  while (i < calls.length) {
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
  }
  return results;
}
