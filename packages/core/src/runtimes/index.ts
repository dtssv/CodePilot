// Built-in example runtimes (ROADMAP-NEXT §4.1 Phase 3).
//
// Importing this module registers `audit` and `mcts` in the process-wide
// registry. Registration is inert: a session only uses them when it is
// configured to (`runtime: "audit"`), and `default` stays the default.
//
// They double as the reference implementations for plugin runtimes — both are
// written against the same `RuntimeToolkit` a plugin gets, so neither can
// reach anything a plugin could not.

import { runtimeRegistry } from "../runtime.js";
import { auditRuntimeFactory } from "./audit.js";
import { mctsRuntimeFactory } from "./mcts.js";

export {
  AuditRuntime,
  auditRuntimeFactory,
  missingAuditSections,
  AUDIT_REQUIRED_SECTIONS,
  AUDIT_RUNTIME_NAME,
} from "./audit.js";
export type { AuditRuntimeOptions } from "./audit.js";

export {
  MctsRuntime,
  mctsRuntimeFactory,
  parseScores,
  selectCandidate,
  selectionNote,
  MCTS_RUNTIME_NAME,
} from "./mcts.js";
export type { MctsCandidate, MctsRuntimeOptions } from "./mcts.js";

/** Register the built-in example runtimes. Idempotent. */
export function registerBuiltinRuntimes(): void {
  runtimeRegistry.register(auditRuntimeFactory);
  runtimeRegistry.register(mctsRuntimeFactory);
}

registerBuiltinRuntimes();
