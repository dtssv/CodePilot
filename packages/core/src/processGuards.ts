// Process-wide fail-soft guards so a plugin (or other) async rejection cannot
// take down the daemon / TUI under Node ≥15's default unhandledRejection=throw.

import { createLogger } from "./telemetry/logger.js";

const log = createLogger("processGuards");

let installed = false;

function formatReason(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  try {
    return String(reason);
  } catch {
    return "[unprintable rejection]";
  }
}

function pluginAttributed(text: string): boolean {
  return /[/\\]plugins[/\\]|codepilot-plugin|plugin[_-]runtime/i.test(text);
}

/**
 * Install once per process: log `unhandledRejection` / `uncaughtException`
 * without rethrowing so the process stays up. Safe to call from multiple
 * entry points (protocol CLI, TUI local).
 */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const text = formatReason(reason);
    const tag = pluginAttributed(text) ? "plugin-attributed " : "";
    log.warn(`unhandledRejection ${tag}${text}`);
  });

  process.on("uncaughtException", (err) => {
    const text = err.stack ?? err.message;
    const tag = pluginAttributed(text) ? "plugin-attributed " : "";
    log.warn(`uncaughtException ${tag}${text}`);
  });
}
