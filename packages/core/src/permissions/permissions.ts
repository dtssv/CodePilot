// Public barrel — re-exports the permissions surface.

export {
  PermissionEngine,
  type PermissionCheckResult,
  type RuleEffect,
  type RuleBuckets,
} from "./permissionEngine.js";

export {
  stripLeadingCd,
  normalizeBashPrimary,
  suggestBashRule,
  isSandboxEscalation,
  bashSensitiveReadHit,
  primaryArgOf,
  matchRule,
} from "./bashRules.js";

export { persistRule, removePersistedRule, listPersistedRules } from "./persist.js";