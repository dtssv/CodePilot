// Desktop/browser notifications when a long-running turn finishes while the
// user is looking elsewhere. Uses the standard Web Notifications API, which
// Electron forwards to the OS, so no desktop preload surface is needed. Fully
// no-ops where Notification is unavailable or permission is denied.

const MIN_RUN_MS = 10_000; // Only notify for turns that ran long enough to matter.

let permissionAsked = false;

function canNotify(): boolean {
  return typeof Notification !== "undefined";
}

/** Ask for permission once, lazily, the first time a run starts. */
export function primeNotifications(): void {
  if (!canNotify() || permissionAsked) return;
  permissionAsked = true;
  if (Notification.permission === "default") {
    void Notification.requestPermission().catch(() => {});
  }
}

/**
 * Notify that a turn finished. Suppressed when the document is focused (the
 * user is already watching) or the run was too short to warrant interrupting.
 */
export function notifyTurnComplete(opts: {
  title: string;
  body: string;
  startedAt: number | undefined;
  onClick?: () => void;
}): void {
  if (!canNotify() || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) {
    return;
  }
  if (opts.startedAt !== undefined && Date.now() - opts.startedAt < MIN_RUN_MS) return;
  try {
    const n = new Notification(opts.title, { body: opts.body, tag: "codepilot-turn" });
    if (opts.onClick) {
      n.onclick = () => {
        window.focus();
        opts.onClick?.();
        n.close();
      };
    }
  } catch {
    /* ignore */
  }
}
