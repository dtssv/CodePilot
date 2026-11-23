import { useCallback, useLayoutEffect, useRef } from "react";

export type StickyScrollOptions = {
  /** Active session id — switching sessions resets stickiness to bottom. */
  sessionKey?: string | null;
  /** Fired when the user scrolls near the top (load older history). */
  onNearTop?: () => void;
};

/** Keeps a scroll container pinned to the bottom unless the user scrolled up.
 * Returns the callback ref to attach to the container, plus a RefObject to the
 * live element so callers (e.g. sub-agent drill-down) can save/restore scroll. */
export function useStickyScroll(
  dep: unknown,
  opts?: StickyScrollOptions,
): { setRef: (el: HTMLDivElement | null) => void; elRef: React.RefObject<HTMLDivElement | null> } {
  // A callback ref, because the container mounts later than the hook runs
  // (after the connect screen, after switching sessions).
  const elRef = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const prevSession = useRef<string | null | undefined>(undefined);
  const prevHeight = useRef(0);
  /** Bumped on session switch / remount so stale pin timers cannot fight. */
  const pinGen = useRef(0);
  const onNearTopRef = useRef(opts?.onNearTop);
  onNearTopRef.current = opts?.onNearTop;
  const sessionKey = opts?.sessionKey ?? null;

  const pinBottom = useCallback((el: HTMLDivElement) => {
    const gen = pinGen.current;
    const pin = (): void => {
      if (pinGen.current !== gen) return;
      if (elRef.current !== el) return;
      // User scrolled away from the bottom — never yank them back.
      if (!stuck.current) return;
      el.scrollTop = el.scrollHeight;
    };
    pin();
    requestAnimationFrame(() => {
      pin();
      requestAnimationFrame(pin);
    });
    // Catch content that grows after a tick (image decode, async markdown).
    setTimeout(pin, 60);
    setTimeout(pin, 200);
  }, []);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stuck.current && !atBottom) {
      // Leaving the bottom invalidates pending pin timers so delayed
      // setTimeout/rAF pins cannot fight upward scroll / history prepend.
      pinGen.current += 1;
    }
    stuck.current = atBottom;
    // Near the top of a long transcript — ask the host to page in older events.
    if (el.scrollTop < 120) onNearTopRef.current?.();
  }, []);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current?.removeEventListener("scroll", onScroll);
      elRef.current = el;
      if (!el) return;
      el.addEventListener("scroll", onScroll);
      pinGen.current += 1;
      stuck.current = true;
      prevHeight.current = 0;
      pinBottom(el);
    },
    [onScroll, pinBottom],
  );

  // Session switch MUST run in useLayoutEffect (before paint) and BEFORE the
  // content effect below. A reused scroll node keeps A's scrollTop≈0 and
  // stuck=false; if content layout runs first it treats B as a prepend and
  // leaves the user at the top of B.
  useLayoutEffect(() => {
    if (prevSession.current === sessionKey) return;
    prevSession.current = sessionKey;
    pinGen.current += 1;
    stuck.current = true;
    prevHeight.current = 0;
    const el = elRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      pinBottom(el);
    }
  }, [sessionKey, pinBottom]);

  // Content growth: if stuck → pin bottom; if the user scrolled up and older
  // history was prepended, preserve the visual anchor (scrollHeight delta).
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const height = el.scrollHeight;
    const prev = prevHeight.current;
    if (stuck.current) {
      pinBottom(el);
    } else if (prev > 0 && height > prev) {
      el.scrollTop += height - prev;
    }
    prevHeight.current = el.scrollHeight;
    // Still near the top after a prepend (or already at 0 with no scroll
    // event) — keep paging older history until the cliff moves.
    if (!stuck.current && el.scrollTop < 120) onNearTopRef.current?.();
  }, [dep, pinBottom]);

  return { setRef, elRef };
}