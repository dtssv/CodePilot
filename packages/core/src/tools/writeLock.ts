/**
 * Per-path async mutex for mutating file tools. Multiple paths are acquired in
 * sorted order to avoid deadlocks when parallel workers touch overlapping sets.
 */

import { resolve } from "node:path";

type Waiter = {
  promise: Promise<void>;
  resolve: () => void;
};

const tails = new Map<string, Promise<unknown>>();

function normalizePath(path: string): string {
  return resolve(path);
}

/** Run `fn` while holding an exclusive lock on `path`. */
export async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizePath(path);
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  // Chain regardless of prior failure so the queue never stalls.
  const next = prev.then(
    () => gate,
    () => gate,
  );
  tails.set(key, next);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // Drop the map entry once our gate is the tip (no further waiters chained
    // onto `next` yet — a concurrent acquirer may have already replaced it).
    if (tails.get(key) === next) tails.delete(key);
  }
}

/** Hold locks on every path (deduped, sorted) then run `fn`. */
export async function withWriteLocks<T>(
  paths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(paths.map(normalizePath))].sort();
  if (keys.length === 0) return fn();
  const run = async (i: number): Promise<T> => {
    if (i >= keys.length) return fn();
    return withPathLock(keys[i]!, () => run(i + 1));
  };
  return run(0);
}

/** Test helper: clear all locks (should be empty between tests). */
export function __resetWriteLocksForTests(): void {
  tails.clear();
}
