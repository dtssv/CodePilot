// Example runtime (a): security audit — read-only with an enforced report
// format. See ROADMAP-NEXT §4.1 Phase 3.
//
// Why a runtime and not a skill or a sub-agent? Because the two guarantees it
// makes are loop-level, not prompt-level:
//
//   1. Read-only, enforced twice. The tool table handed to the model is
//      filtered to the read-only set, and every tool call is re-checked on
//      the way out (the loop's mode gate). A prompt saying "don't edit
//      files" is a request; this is a property of the run.
//   2. The report contract is verified, not hoped for. When the final answer
//      is missing a required section, the runtime spends another turn asking
//      for a conforming rewrite instead of returning a half-report.
//
// Everything else — streaming, permissions, hooks, telemetry, persistence —
// is inherited by delegating to the built-in loop through the toolkit.

import type { AgentDeps, AgentRunInput, AgentRunResult } from "../agent.js";
import type {
  AgentRuntime,
  AgentRuntimeState,
  RuntimeFactory,
  RuntimeFactoryDeps,
  RuntimeToolkit,
} from "../runtime.js";
import type { AgentMode } from "../types.js";
import { aborted, mergeRunResults, withPromptSuffix } from "./_shared.js";

export const AUDIT_RUNTIME_NAME = "audit";

/** Headings the final report must contain (matched case-insensitively). */
export const AUDIT_REQUIRED_SECTIONS = ["Summary", "Findings", "Recommendations"] as const;

const REPORT_CONTRACT = `<audit_runtime>
You are running under the "audit" runtime: a read-only security review. You
cannot edit files or run commands — write and execute tools are not available
to you, and calls to them are refused. Do not promise fixes you cannot make.

Produce your final answer as Markdown with exactly these top-level sections,
in this order:

## Summary
Two to four sentences: what was reviewed, and the overall risk posture.

## Findings
One "###" subsection per finding, ordered most severe first. Each one states:
- **Severity**: critical | high | medium | low
- **Location**: \`path/to/file.ts:line\`
- **Evidence**: the specific code or configuration that creates the risk
- **Impact**: what an attacker gains

Write "No findings." under the heading if the review found nothing.

## Recommendations
Concrete, ordered remediation steps, each naming the file it applies to.
</audit_runtime>`;

function repairInstruction(missing: string[]): string {
  return (
    `[audit runtime] Your report is missing these required sections: ` +
    `${missing.join(", ")}. Rewrite the complete report now, keeping every ` +
    `finding you already reported, using exactly the required section ` +
    `headings (## Summary, ## Findings, ## Recommendations). Output only the ` +
    `report.`
  );
}

/** Required sections absent from a report body. */
export function missingAuditSections(report: string): string[] {
  return AUDIT_REQUIRED_SECTIONS.filter(
    (section) => !new RegExp(`^#{1,3}\\s*${section}\\b`, "im").test(report),
  );
}

export interface AuditRuntimeOptions {
  /**
   * Collaboration mode the audit runs in. Default `"chat"` — the read-only
   * baseline. `"plan"` additionally allows `plan_update` / `memory_write`,
   * which is useful when the audit should leave notes behind. `"agent"` is
   * rejected: it would defeat the runtime's only hard guarantee.
   */
  mode?: Exclude<AgentMode, "agent">;
  /** How many reformat turns to spend on a non-conforming report. Default 1. */
  maxRepairAttempts?: number;
}

export class AuditRuntime implements AgentRuntime {
  readonly name = AUDIT_RUNTIME_NAME;
  private currentState: AgentRuntimeState = "idle";
  private readonly mode: Exclude<AgentMode, "agent">;
  private readonly maxRepairAttempts: number;

  constructor(
    private readonly toolkit: RuntimeToolkit,
    opts: AuditRuntimeOptions = {},
  ) {
    // Checked at runtime too: the type excludes "agent", but options can
    // arrive from JSON config, and a read-only runtime that quietly accepted
    // a writable mode would be worse than one that refuses to start.
    if ((opts.mode as AgentMode | undefined) === "agent") {
      throw new Error(
        'audit runtime: mode "agent" defeats the read-only guarantee; use "chat" or "plan"',
      );
    }
    this.mode = opts.mode ?? "chat";
    this.maxRepairAttempts = Math.max(0, opts.maxRepairAttempts ?? 1);
  }

  async prompt(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult> {
    this.currentState = "running";
    try {
      const auditDeps: AgentDeps = {
        ...deps,
        agentMode: this.mode,
        systemPrompt: withPromptSuffix(deps.systemPrompt, REPORT_CONTRACT),
      };

      const runs: AgentRunResult[] = [await this.toolkit.runDefault(input, auditDeps)];
      let missing = missingAuditSections(runs[runs.length - 1]!.finalText);

      for (let attempt = 0; attempt < this.maxRepairAttempts; attempt++) {
        if (missing.length === 0 || aborted(deps)) break;
        // Replay everything produced so far as history so the rewrite keeps
        // the findings instead of re-reading the codebase.
        const history = [...input.history, ...runs.flatMap((r) => r.events)];
        runs.push(
          await this.toolkit.runDefault(
            { history, userText: repairInstruction(missing) },
            auditDeps,
          ),
        );
        missing = missingAuditSections(runs[runs.length - 1]!.finalText);
      }

      const merged = mergeRunResults(runs);
      if (missing.length > 0 && !aborted(deps)) {
        // The contract could not be met. Say so rather than passing a
        // malformed report off as a clean audit.
        const event = {
          type: "error" as const,
          message:
            `audit runtime: report is still missing ${missing.join(", ")} after ` +
            `${this.maxRepairAttempts} repair attempt(s)`,
          recoverable: true,
        };
        merged.events.push(event);
        await deps.onEvent?.(event);
      }
      return merged;
    } finally {
      this.currentState = "idle";
    }
  }

  cancel(): void {
    // Cancellation flows through deps.signal, which the built-in loop honours.
  }

  state(): AgentRuntimeState {
    return this.currentState;
  }
}

/** Factory for the audit runtime, registered under the name `"audit"`. */
export const auditRuntimeFactory: RuntimeFactory = {
  name: AUDIT_RUNTIME_NAME,
  create: (deps: RuntimeFactoryDeps) => new AuditRuntime(deps.toolkit),
};
