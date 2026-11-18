/**
 * Shared prompt fragments used by more than one surface (parent blocks,
 * sub-agent templates). Keep one source of truth so regression fixes do not
 * fork into divergent copies.
 */

/**
 * Failure classification + bounded interactive probes.
 * Used by parent `# Doing tasks` and worker `**Errors.**`.
 */
export const ERROR_CLASSIFY_BOUNDED_PROBES =
  "Classify failures: **business/logic** (target started but logic/output wrong — fix once); " +
  "**permission/sandbox deny** (do not tweak-and-retry — switch tools or escalate); " +
  "**transient** (timeout/network — retry **once** only for read-only probes/status; never auto-retry POST/writes/side-effecting shell). " +
  "Command-not-found / connect-refused / timeout are **not** business. " +
  "Bound interactive/long-lived probes (`ping -c N`, short timeouts); if omitted, **add bounds** — never open-ended `ping`/`tail -f`/`telnet`/`ssh`/`nc` without an exit.";
