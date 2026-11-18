// Re-export barrel — keep `from "./sandbox/sandbox.js"` stable.
export type {
  SandboxMode,
  ResolvedSandbox,
  WrappedCommand,
  SandboxBackend,
  SandboxUnavailable,
  ShellEnvOptions,
  PathCheckResult,
  DangerCheck,
} from "./types.js";
export { SANDBOX_PROMPT_EXTRA_ROOTS_CAP } from "./types.js";

export {
  formatSandboxPromptNote,
  resolveSandbox,
  codepilotControlPaths,
  networkDenied,
  SENSITIVE_READ_PATHS,
  SENSITIVE_WRITE_PATHS,
  sensitivePathHit,
  gitMetadataWriteHit,
  writableRootForTarget,
  isWriteOutsideSandbox,
  isInsideWorkingSet,
  cloneSandbox,
  addWritableRoot,
  looksLikeSandboxWriteDenial,
  looksLikeSandboxNetworkDenial,
  assertPathAllowed,
  assertPathAllowedAsync,
  checkDangerousCommand,
} from "./policy.js";

export {
  sandboxUnavailableHint,
  buildSandboxUnavailable,
  landlockLauncherPath,
  detectSandboxBackend,
  resetSandboxBackendCache,
  slirp4netnsPath,
} from "./backend.js";

export {
  shellQuote,
  buildSeatbeltProfile,
  shellEnvAllowed,
  modelShellEnv,
  wrapCommand,
  bwrapSensitiveMasks,
  winPathToWsl,
} from "./wrap.js";
