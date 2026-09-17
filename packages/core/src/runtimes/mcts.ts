// Example runtime (b): search-based exploration for open-ended tasks.
// See ROADMAP-NEXT §4.1 Phase 3.
//
// Naming, precisely: this is *flat* Monte-Carlo search — one level of
// expansion, then evaluation and selection — not UCT with tree reuse across
// prompts. The four phases map onto the usual vocabulary:
//
//   expand    N read-only rollouts, each pushed toward a different approach
//   simulate  one scoring pass that rates every candidate against a rubric
//   select    take the highest-scoring candidate (ties → first, i.e. lowest
//             temperature-of-exploration order)
//   exploit   run the task for real, in the session's own mode, with the
//             winning approach injected as guidance
//
// The expansion phase is deliberately read-only: N independent loops all
// editing the same working tree would interleave writes, and the point of
// the search is to compare approaches before committing to one. Only the
// exploit phase can modify anything.
//
// Cost: N + 2 provider runs per prompt (N exploration + 1 scoring +
// 1 exploitation). That is the trade — spend tokens to avoid committing to
// the first plan the model thinks of.

import { randomUUID } from "node:crypto";
import type { AgentDeps, AgentRunInput, AgentRunResult } from "../agent.js";
import type {
  AgentRuntime,
  AgentRuntimeState,
  RuntimeFactory,
  RuntimeFactoryDeps,
  RuntimeToolkit,
} from "../runtime.js";
import type { AgentMode, Event } from "../types.js";
import { aborted, mergeRunResults, withPromptSuffix } from "./_shared.js";

export const MCTS_RUNTIME_NAME = "mcts";

/** One explored approach. */
export interface MctsCandidate {
  index: number;
  /** The angle the rollout was pushed toward. */
  angle: string;
  /** The approach the rollout produced. */
  text: string;
  /** Rubric score in [0, 10]; undefined when scoring failed. */
  score?: number;
  /** One-line justification from the scoring pass. */
  reason?: string;
}

/** Distinct exploration angles, cycled when `candidates` exceeds the list. */
const ANGLES = [
  "the most direct solution that touches the fewest files",
  "the most robust solution, even if it takes more work",
  "the solution that best matches existing patterns in this codebase",
  "the solution with the lowest risk of breaking current behaviour",
  "a solution that questions the premise of the request, if it deserves it",
];

function explorePrompt(angle: string, task: string): string {
  return `<mcts_runtime phase="expand">
Explore ONE approach to the task below, biased toward ${angle}.

You are read-only in this phase: investigate the code with the read tools,
then answer with your proposed approach — the files you would change, what
each change does, and the risks you see. Do not write a full implementation
and do not claim the work is done; another phase will carry it out.

Task: ${task}
</mcts_runtime>`;
}

function scorePrompt(candidates: MctsCandidate[], task: string): string {
  const list = candidates
    .map((c) => `<candidate index="${c.index}" angle="${c.angle}">\n${c.text}\n</candidate>`)
    .join("\n\n");
  return `<mcts_runtime phase="simulate">
Score each candidate approach to this task, from 0 (unusable) to 10 (ship it),
on: correctness, fit with the existing codebase, risk, and effort.

Task: ${task}

${list}

Reply with ONLY a JSON array, no prose, no code fence:
[{"index": 1, "score": 7, "reason": "one line"}, ...]
</mcts_runtime>`;
}

function exploitPrompt(winner: MctsCandidate, task: string): string {
  return `<mcts_runtime phase="exploit">
You explored several approaches and selected this one${
    winner.score !== undefined ? ` (score ${winner.score}/10)` : ""
  }:

${winner.text}

Carry out the task using that approach. Deviate from it only if you discover
it is wrong, and say so when you do.

Task: ${task}
</mcts_runtime>`;
}

/** Parse the scoring pass's JSON array. Tolerates code fences and prose. */
export function parseScores(text: string): Map<number, { score: number; reason?: string }> {
  const out = new Map<number, { score: number; reason?: string }>();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { index, score, reason } = entry as Record<string, unknown>;
    if (typeof index !== "number" || typeof score !== "number") continue;
    if (!Number.isFinite(score)) continue;
    out.set(index, {
      score: Math.min(10, Math.max(0, score)),
      reason: typeof reason === "string" ? reason : undefined,
    });
  }
  return out;
}

/**
 * Pick the winner: highest score wins, ties go to the earlier candidate.
 * With no scores at all (scoring failed or returned junk) the first
 * candidate wins — arbitrary, but better than abandoning the run.
 */
export function selectCandidate(candidates: MctsCandidate[]): MctsCandidate {
  let best = candidates[0]!;
  for (const c of candidates) {
    if ((c.score ?? -1) > (best.score ?? -1)) best = c;
  }
  return best;
}

/**
 * The scoreboard, as a transcript message. It goes into the log (and into
 * the exploit phase's history) because a run that silently discarded four of
 * five explored approaches is impossible to review after the fact.
 */
export function selectionNote(
  candidates: MctsCandidate[],
  winner: MctsCandidate,
): Event {
  const rows = candidates
    .map(
      (c) =>
        `${c.index === winner.index ? "→" : " "} #${c.index} ` +
        `score ${c.score ?? "n/a"}/10 — ${c.angle}` +
        `${c.reason ? `\n     ${c.reason}` : ""}`,
    )
    .join("\n");
  return {
    type: "message",
    id: `msg_${randomUUID()}`,
    role: "assistant",
    content: [
      {
        type: "text",
        text:
          `[mcts runtime] explored ${candidates.length} approaches, ` +
          `selected #${winner.index}:\n${rows}`,
      },
    ],
  };
}

export interface MctsRuntimeOptions {
  /** How many approaches to explore. Clamped to 2–5. Default 3. */
  candidates?: number;
  /** Mode for the read-only exploration rollouts. Default "plan". */
  exploreMode?: Exclude<AgentMode, "agent">;
  /** Skip the exploit phase and return the selected approach as the answer.
   *  Useful for "just tell me the options" usage. Default false. */
  proposeOnly?: boolean;
}

function readOptions(deps: AgentDeps, fallback: MctsRuntimeOptions): MctsRuntimeOptions {
  const raw = deps.config.runtimeOptions?.[MCTS_RUNTIME_NAME];
  if (typeof raw !== "object" || raw === null) return fallback;
  const o = raw as Record<string, unknown>;
  return {
    candidates: typeof o.candidates === "number" ? o.candidates : fallback.candidates,
    exploreMode:
      o.exploreMode === "chat" || o.exploreMode === "plan" ? o.exploreMode : fallback.exploreMode,
    proposeOnly:
      typeof o.proposeOnly === "boolean" ? o.proposeOnly : fallback.proposeOnly,
  };
}

export class MctsRuntime implements AgentRuntime {
  readonly name = MCTS_RUNTIME_NAME;
  private currentState: AgentRuntimeState = "idle";
  /** Candidates from the most recent prompt, for host introspection. */
  private lastCandidates: MctsCandidate[] = [];

  constructor(
    private readonly toolkit: RuntimeToolkit,
    private readonly defaults: MctsRuntimeOptions = {},
  ) {}

  /** The explored candidates of the last run, scored and in expansion order. */
  candidates(): readonly MctsCandidate[] {
    return this.lastCandidates;
  }

  async prompt(input: AgentRunInput, deps: AgentDeps): Promise<AgentRunResult> {
    this.currentState = "running";
    try {
      const opts = readOptions(deps, this.defaults);
      const count = Math.min(5, Math.max(2, opts.candidates ?? 3));
      const exploreMode = opts.exploreMode ?? "plan";
      const task = input.userText;

      // --- expand: N read-only rollouts -------------------------------
      // Sequential, not parallel: the rollouts share one provider, one rate
      // limit, and one permission channel, and a later rollout benefits from
      // nothing a concurrent one learns. Cancellation is checked between them.
      const runs: AgentRunResult[] = [];
      const candidates: MctsCandidate[] = [];
      for (let i = 0; i < count; i++) {
        if (aborted(deps)) break;
        const angle = ANGLES[i % ANGLES.length]!;
        const run = await this.toolkit.runDefault(
          { history: input.history, userText: explorePrompt(angle, task), images: input.images },
          { ...deps, agentMode: exploreMode },
        );
        runs.push(run);
        candidates.push({ index: i + 1, angle, text: run.finalText });
      }
      this.lastCandidates = candidates;
      if (candidates.length === 0) {
        return { events: runs.flatMap((r) => r.events), hadToolCalls: false, finalText: "" };
      }

      // --- simulate: score the candidates -----------------------------
      if (!aborted(deps)) {
        const scoring = await this.toolkit.runDefault(
          { history: [], userText: scorePrompt(candidates, task) },
          {
            ...deps,
            agentMode: "chat",
            // Scoring is a judgement call on text we already have; no tools,
            // and no transcript pollution from the rubric round-trip.
            onEvent: undefined,
            systemPrompt: withPromptSuffix(
              deps.systemPrompt,
              "You are scoring candidate approaches. Reply with JSON only.",
            ),
          },
        );
        const scores = parseScores(scoring.finalText);
        for (const c of candidates) {
          const s = scores.get(c.index);
          if (s) {
            c.score = s.score;
            c.reason = s.reason;
          }
        }
      }

      // --- select -----------------------------------------------------
      const winner = selectCandidate(candidates);
      const selection = selectionNote(candidates, winner);
      runs.push({ events: [selection], hadToolCalls: false, finalText: "" });
      await deps.onEvent?.(selection);

      // --- exploit: do the work with the winning approach -------------
      if (opts.proposeOnly === true || aborted(deps)) {
        return { ...mergeRunResults(runs), finalText: winner.text };
      }
      const history = [...input.history, ...runs.flatMap((r) => r.events)];
      runs.push(
        await this.toolkit.runDefault(
          { history, userText: exploitPrompt(winner, task), images: input.images },
          deps,
        ),
      );
      return mergeRunResults(runs);
    } finally {
      this.currentState = "idle";
    }
  }

  cancel(): void {
    // Cancellation flows through deps.signal, checked between phases.
  }

  state(): AgentRuntimeState {
    return this.currentState;
  }
}

/** Factory for the search runtime, registered under the name `"mcts"`. */
export const mctsRuntimeFactory: RuntimeFactory = {
  name: MCTS_RUNTIME_NAME,
  create: (deps: RuntimeFactoryDeps) => new MctsRuntime(deps.toolkit),
};
