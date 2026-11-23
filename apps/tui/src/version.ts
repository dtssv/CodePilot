/**
 * Single source for the version string shown by `--version`, the welcome
 * banner and the status bar. It is inlined rather than read from package.json
 * because a compiled binary cannot resolve its own package metadata reliably.
 * Keep it equal to `apps/tui/package.json` "version".
 */
export const VERSION = "1.0.0";
