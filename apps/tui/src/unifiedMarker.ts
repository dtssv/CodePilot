/**
 * Marks this process as the unified binary driven by the TUI entry. In a
 * Bun-compiled binary all modules share one `import.meta.url`, so the protocol
 * CLI can't tell by path if it is the entry. Importing this first sets a global
 * flag the protocol CLI checks to suppress its own self-execution, keeping
 * control with the TUI entry's command router.
 */

(globalThis as { __CODEPILOT_UNIFIED__?: boolean }).__CODEPILOT_UNIFIED__ = true;

export {};
