/**
 * Marks this process as the unified binary driven by the TUI entry.
 *
 * In a Bun-compiled binary every module shares one `import.meta.url`, so the
 * protocol CLI cannot tell by path whether it is the real entry point. Importing
 * this module first (from the TUI entry) sets a global flag that the protocol
 * CLI checks to suppress its own self-execution, so control stays with the TUI
 * entry's command router.
 */

(globalThis as { __CODEPILOT_UNIFIED__?: boolean }).__CODEPILOT_UNIFIED__ = true;

export {};
