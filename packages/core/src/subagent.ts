// Sub-agent runner: a thin wrapper around `runAgent` that runs with a fresh
// transcript, a restricted tool set, and returns only the final text.
//
// The sub-agent gets its own system prompt built on top of the shared
// `buildSystemPrompt` static prefix, with an additional block that bounds
// its scope: it is a focused worker, it does not own the user's task, and
// it returns a structured conclusion.

import { randomUUID } from "node:crypto";
import { detectDegenerateText, detectRunawayRepetition } from "./textDegeneration.js";
import { runAgent, type AgentDeps, isTransientError } from "./agent.js";
import type { CodepilotConfig, Event, QuestionAnswers, UsageInfo } from "./types.js";
import { ToolRegistry } from "./tools/types.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { buildProvider } from "./session-utils.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { readMemory, summariseMemory } from "./memory.js";
import { resolveSandbox } from "./sandbox.js";
import type { SubagentRunner } from "./tools/task.js";
import { createWorktree, removeWorktree, worktreeDiffStat } from "./worktree.js";
import { projectStatePath } from "./projectState.js";
import { SubagentStore } from "./subagentStore.js";

/** Max times we re-ask the user to extend a capped sub-agent (cost guard). */
const MAX_BUDGET_EXTENSIONS = 8;

/**
 * Decide the PermissionEngine a sub-agent runs under. A fresh, independent
 * engine is used when:
 *  - the custom agent declares its own permissionMode (always independent),
 *  - there is no parent engine to inherit (tests / minimal harness), or
 *  - config `subagentPermissions: "independent"` opts a built-in sub-agent
 *    out of sharing the parent's live engine.
 * Default ("inherit") shares the parent engine so session-approved allow
 * rules carry in — today's behavior. "independent" closes the gap where a
 * mid-session grant to the parent silently widened a built-in sub-agent.
 */
export function resolveSubagentPermissions(args: {
  parent?: PermissionEngine;
  customPermissionMode?: import("./types.js").PermissionMode;
  policy?: "inherit" | "independent";
  autoApprove?: string[];
}): PermissionEngine {
  const { parent, customPermissionMode, policy, autoApprove } = args;
  if (customPermissionMode || !parent || policy === "independent") {
    return new PermissionEngine({
      permissionMode: customPermissionMode ?? "auto-edit",
      autoApprove,
    });
  }
  return parent;
}

/** Sum usage events from a sub-agent transcript (adopted attempt only). */
function sumUsageFromEvents(events: Event[]): UsageInfo {
  let usage: UsageInfo = { input: 0, output: 0 };
  for (const e of events) {
    if (e.type !== "usage") continue;
    usage = {
      input: usage.input + e.usage.input,
      output: usage.output + e.usage.output,
      cacheRead: sumOptional(usage.cacheRead, e.usage.cacheRead),
      cacheWrite: sumOptional(usage.cacheWrite, e.usage.cacheWrite),
      costUSD: sumOptional(usage.costUSD, e.usage.costUSD),
    };
  }
  return usage;
}

function sumOptional(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * The block appended to a sub-agent's static prefix. It makes the role
 * boundary crisp so the sub-agent does not drift into doing the parent's
 * job, and it tells the sub-agent the exact shape of the conclusion it
 * must return.
 */
export const SUBAGENT_ROLE_BLOCK = `## Sub-Agent Role

You are a sub-agent invoked by a parent CodePilot agent via the \`task\` tool. You are NOT the user's assistant; the parent is. You are a focused, throwaway worker.

- **Scope.** The parent has delegated one bounded objective to you (in the user message of this turn). Do exactly that objective, no more, no less.
- **Do not address the user.** The user cannot see you. Never greet them, never ask them questions, never narrate progress. If essential information is missing, investigate with the tools available; if still blocked, return a blocker in your conclusion.
- **No nested sub-agents.** Do not call the \`task\` tool. You are already a sub-agent.
- **Default tool surface is read-only** (agent type \`explore\`). You have \`read_file\`, \`grep\`, \`glob\`, \`ls\`, \`read_artifact\`, plus the network research tools \`web_fetch\` and \`web_search\` (and any others the parent explicitly listed). If you are a \`worker\` sub-agent, you additionally have \`write_file\` / \`edit_file\` / \`bash\` — complete the delegated change, then **verify before reporting**: run the relevant test/build/lint (or other acceptance check) and include the command + exit outcome in Findings. Do not report success on unverified writes. \`plan_update\` and \`memory_write\` are never available. If the parent asks you to "fix" or "implement" something but you lack write tools, say so in your conclusion and stop.
- **Conclusion format.** End your work with a final assistant message that contains a structured conclusion. Use this exact format:

 ### Findings
  - <bullet 1 — what you discovered, with file:line references>
  - <bullet 2 — ...>

 ### Key references
  - \`path/to/file.ts:42\` — one-line purpose
  - \`path/to/other.ts:118-140\` — another purpose

 ### Recommendations
  - <concrete next step for the parent to take, or "none">

  If you could not complete the work, replace the sections above with:
 ### Blocker
  <one-sentence reason the work could not be completed>

- **Be terse.** The parent is paying for your tokens too. No preamble, no apology, no recap of the question. The structured conclusion is the entire output.`;

export interface SubagentFactoryOptions {
  cwd: string;
  config: CodepilotConfig;
  model: string;
 /** Live view of the parent's endpoint. The parent can switch provider /
 * model after the runner is built; sub-agents must follow it. */
  getEndpoint?: () => { config: CodepilotConfig; model: string };
 /** The parent's permission engine and prompt channel. Sub-agent tool calls
 * are judged by the parent's mode and rules and ask the parent's user, so
 * dispatching a sub-agent never widens what may run unattended. */
  permissions?: PermissionEngine;
  onPermissionRequest?: AgentDeps["onPermissionRequest"];
 /** Parent's structured question channel — used to ask whether to extend a
  * capped sub-agent after it hits `maxSteps` / custom `maxTurns`. */
  onAskUser?: AgentDeps["onAskUser"];
 /** Live parent sandbox (so expand-dir grants apply to sub-agents too). */
  getSandbox?: () => import("./sandbox.js").ResolvedSandbox;
  expandSandboxWritable?: AgentDeps["expandSandboxWritable"];
 /** Inherit parent's delivery roots / scratch so worker writes stay on-task. */
  getDeliveryRoots?: () => string[];
  addDeliveryRoot?: AgentDeps["addDeliveryRoot"];
  scratchDir?: () => string | undefined;
  projectStateDir?: () => string | undefined;
 /** Build the tool registry for the given agent type. */
  buildToolRegistry: (agentType?: "explore" | "worker") => ToolRegistry;
 /** Optional hook engine to fire SubagentStop events (may block + continue). */
  hooks?: {
    runSubagentStop: (
      agentType: string,
      conclusion: string,
      extra?: Record<string, unknown>,
    ) => Promise<{ action: "allow" | "block"; reason?: string; warnings: string[] }>;
  };
 /**
 * Optional resolver for custom agents (`.codepilot/agents/*.md`). When
 * the requested `agentType` is neither "explore" nor "worker", this is
 * called to look up a custom agent definition by name. Returns undefined
 * for unknown names (the runner then falls back to "explore").
 */
  resolveCustomAgent?: (name: string) => Promise<import("./customAgents.js").CustomAgent | undefined>;
}

export function createSubagentRunner(
  factoryOpts: SubagentFactoryOptions
): SubagentRunner {
  return {
    async run({ objective, cwd, agentType, tools, model, maxSteps, onEvent, onLiveEvent, depth, outputSchema, isolation, resumeSessionId, continueText, ownerId }) {
      const live = factoryOpts.getEndpoint?.();
      const opts: SubagentFactoryOptions = live
        ? { ...factoryOpts, config: live.config, model: live.model }
        : factoryOpts;
 // Resolve a custom agent definition when the type isn't a built-in.
      const isBuiltin = agentType === "explore" || agentType === "worker" || agentType === undefined;
      const custom = !isBuiltin && opts.resolveCustomAgent
        ? await opts.resolveCustomAgent(agentType!).catch(() => undefined)
        : undefined;
 // Effective type: custom agents use "worker" as the base tool surface
 // (so their frontmatter `tools` allowlist can narrow it); unknown
 // custom names fall back to "explore".
      const effectiveType: "explore" | "worker" = custom ? "worker" : (agentType === "worker" ? "worker" : "explore");
      const effectiveModel =
        pickServedModel(opts, model) ??
        pickServedModel(opts, custom?.model) ??
        pickServedModel(opts, opts.config.smallModel) ??
        opts.model;
      // Unset = unlimited (doom-loop / cancel / timeout still apply). Only cap
      // when the parent `task` call or custom-agent frontmatter sets a value.
      const effectiveMaxSteps = maxSteps ?? custom?.maxTurns;

 // Filesystem isolation: when `isolation === "worktree"`, create a
 // linked git worktree on a fresh branch and run the sub-agent there.
 // Its edits land in an isolated checkout; we clean up (and surface a
 // diff stat) in the finally block below. Falls back to the parent cwd
 // if git is unavailable or worktree creation fails — isolation is a
 // best-effort feature, never a hard requirement.
      // Unique owner id for this sub-agent run. Stamped onto any background
      // jobs it starts so `write_stdin` refuses cross-agent writes — critical
      // when worktree isolation falls back to a shared parent cwd, where the
      // bashJobs registry (keyed only by cwd) would otherwise let sibling
      // sub-agents reach each other's job stdin.
      //
      // Prefer the id the `task` tool assigned (so the progress events, the
      // persisted transcript, and the returned session_id all match); a resume
      // reuses the prior id; otherwise mint a fresh one.
      const subagentOwnerId = ownerId ?? resumeSessionId ?? `sub_${randomUUID()}`;
      const isResume = Boolean(resumeSessionId);
      let worktreeHandle: import("./worktree.js").WorktreeHandle | null = null;
      let effectiveCwd = cwd;
      let isolationNote = "";
      let isolationFellBack = false;
      if (isolation === "worktree") {
        const wt = await createWorktree({
          cwd,
          label: custom?.name ?? agentType ?? "subagent",
        });
        if (wt.ok) {
          worktreeHandle = wt.worktree;
          effectiveCwd = wt.worktree.path;
          isolationNote =
            `\n\n[worktree isolation] You are running in a linked git worktree.\n` +
            `  path: ${wt.worktree.path}\n  branch: ${wt.worktree.branch}\n` +
            `  base: ${wt.worktree.baseRef}\n` +
            `Your edits land in this isolated checkout and do NOT affect the parent's working tree. ` +
            `The worktree is removed automatically when you finish; if you produce commits the branch is kept for the parent to merge.`;
        } else {
 // Fall back to the parent cwd. Surface the reason prominently in
 // both the sub-agent's prompt and (later) its conclusion, because a
 // parallel fan-out that each asked for worktree isolation and
 // silently got none can have two workers writing the SAME files in
 // the parent tree — clobbering each other with no record.
          isolationFellBack = true;
          isolationNote =
            `\n\n⚠️ [worktree isolation UNAVAILABLE] requested isolation could not be set up ` +
            `(${wt.reason} — ${wt.message}). You are running directly in the parent's working ` +
            `tree (${cwd}). If other sub-agents are running in parallel, DO NOT assume your ` +
            `file writes are isolated — coordinate or avoid editing the same files, and report ` +
            `exactly which files you changed in your conclusion.`;
        }
      }

      try {
      // Reuse the shared provider builder so sub-agents get the same fallback
      // chain as the main session. Override model/smallModel to the sub-agent's
      // chosen model; a fallback entry that sets its own model still wins (it is
      // spread last in buildProvider), and one that doesn't inherits this model.
      const provider = buildProvider({
        ...opts.config,
        model: effectiveModel ?? opts.config.model,
        smallModel: effectiveModel ?? opts.config.smallModel ?? opts.config.model,
      });
      let toolRegistry = opts.buildToolRegistry(effectiveType);
 // Custom agent tool allowlist / denylist.
      if (custom?.tools && custom.tools.length > 0) {
        const filtered = new ToolRegistry();
        for (const n of custom.tools) {
          const t = toolRegistry.get(n);
          if (t) filtered.register(t);
        }
        toolRegistry = filtered;
      }
      if (custom?.disallowedTools && custom.disallowedTools.length > 0) {
        const filtered = new ToolRegistry();
        const deny = new Set(custom.disallowedTools);
        for (const t of toolRegistry.all()) {
          if (!deny.has(t.name)) filtered.register(t);
        }
        toolRegistry = filtered;
      }
 // Optional restriction by tool name (from the `task` call).
      let restricted = toolRegistry;
      if (tools && tools.length > 0) {
        restricted = new ToolRegistry();
        for (const n of tools) {
          const t = toolRegistry.get(n);
          if (t) restricted.register(t);
        }
      }
      const artifacts = new ArtifactStore(joinCodepilot(effectiveCwd, "artifacts"));
      await artifacts.init();
      const permissions = resolveSubagentPermissions({
        parent: opts.permissions,
        customPermissionMode: custom?.permissionMode,
        policy: opts.config.subagentPermissions,
        autoApprove: opts.config.autoApprove,
      });
 // Memory is read from the parent cwd — a worktree sub-agent should
 // still see project/user memory, but it writes artifacts into its own
 // isolated checkout. Uses an isolated checkout for the sub-agent.
      const memory = summariseMemory(await readMemory(cwd));
 // Sub-agents always run in "agent" mode (the chat/plan restrictions
 // would be over-restrictive for a delegated worker, and the tool
 // surface itself is already mode-filtered upstream by `task` callers).
 // We still pass the parent's `extra` so project notes propagate.
 // For custom agents, the agent's body (its system-prompt supplement)
 // is prepended to the role block.
      const baseRoleBlock = custom
        ? `${custom.body}\n\n---\n\n${SUBAGENT_ROLE_BLOCK}`
        : SUBAGENT_ROLE_BLOCK +
          (effectiveType === "worker" ? `\n\nYou are a **worker** sub-agent: you may edit files and run commands. Verify your change before concluding.` : "");
 // When an output schema is requested, override the conclusion-format
 // instructions with a JSON contract so the parent can parse the
 // result programmatically.
      const roleBlock = outputSchema
        ? `${baseRoleBlock}\n\n${structuredOutputBlock(outputSchema)}`
        : baseRoleBlock;
      const sys = await buildSystemPrompt({
        cwd: effectiveCwd,
        memory,
        toolNames: restricted.names(),
        extra: roleBlock + (isolationNote ? isolationNote : ""),
        model: effectiveModel ?? opts.model,
        provider: opts.config.provider ?? "anthropic",
        mode: "agent",
      });

      // Durable transcript store: persists this sub-agent's replayable events
      // so it can be CONTINUED later (parent passes its id as
      // continue_session_id) and so an interrupted in-flight run survives.
      const stateDir = opts.projectStateDir?.();
      const store = stateDir ? new SubagentStore(stateDir) : null;

      // Load a prior transcript when continuing an existing sub-agent.
      const priorEvents: Event[] = isResume && store ? await store.load(subagentOwnerId) : [];
      const resuming = isResume && priorEvents.length > 0;

      const userMessageId = `msg_${randomUUID()}`;
      const footer = outputSchema
        ? STRUCTURED_OUTPUT_FOOTER
        : SUBAGENT_OBJECTIVE_FOOTER;
      // A resumed sub-agent already knows its role and prior context: send the
      // bare follow-up (no OBJECTIVE/role preamble). A fresh run gets the full
      // objective + conclusion-format footer.
      const initialText = resuming
        ? (continueText ?? objective)
        : `OBJECTIVE:\n${objective}\n\n${footer}`;
      const initial: Event = {
        type: "message",
        id: userMessageId,
        role: "user",
        content: [{ type: "text", text: initialText }],
      };

 // Sub-agent retry: the whole sub-agent run is retried in place for
 // transient failures only (rate limit, dropped socket, gateway 5xx),
 // with exponential backoff. Deterministic failures (bad schema,
 // genuine blocker) are returned on the first attempt — retrying them
 // would just burn tokens.
      const maxSubAttempts = Math.max(1, opts.config.turnRetries ?? 2);
      let events: Event[] = [];
      let outcome = assessSubagentOutcome(events);
      let reachedTurnBudget = false;
      const makeDeps = (maxTurns: number): AgentDeps => ({
        provider,
        tools: restricted,
        artifacts,
        permissions,
        config: { ...opts.config, model: effectiveModel ?? opts.config.smallModel },
        cwd: effectiveCwd,
        sessionId: subagentOwnerId,
        systemPrompt: sys,
        // 0 = unlimited; must set explicitly so parent config.maxTurns is not inherited.
        maxTurns,
        isSubagent: true,
        // When a structured result is requested and the provider speaks the
        // OpenAI dialect (incl. Azure, which reuses that provider), additionally
        // constrain output with native json_schema. The prompt+parse path in
        // structuredOutputBlock / extractStructuredJson still runs and validates,
        // so this is a strict upgrade (native enforcement where available,
        // prompt-only elsewhere).
        responseFormat:
          outputSchema && provider.name === "openai"
            ? { name: "subagent_result", schema: outputSchema, strict: false }
            : undefined,
        sandbox: opts.getSandbox?.() ?? resolveSandbox(opts.config.sandbox, effectiveCwd),
        expandSandboxWritable: opts.expandSandboxWritable,
        deliveryRoots: opts.getDeliveryRoots?.() ?? [effectiveCwd],
        addDeliveryRoot: opts.addDeliveryRoot,
        scratchDir: opts.scratchDir?.(),
        projectStateDir: opts.projectStateDir?.(),
        subagentDepth: (depth ?? 0) + 1,
        onEvent: async (e) => {
          if (e.type !== "activity") events.push(e);
          try { onLiveEvent?.(e); } catch { /* a UI listener must not break the run */ }
        },
        onPermissionRequest: opts.onPermissionRequest,
        onAskUser: opts.onAskUser,
      });

      for (let attempt = 0; attempt < maxSubAttempts; attempt++) {
 // Fresh transcript per attempt — a half-finished prior attempt must
 // not leak into the retry's context or its outcome assessment.
        events = [];
        reachedTurnBudget = false;
        let threw: Error | null = null;
        try {
 // Prepend the initial event as history so runAgent doesn't double-emit it.
 // When continuing an existing sub-agent, seed the history with its prior
 // transcript so it resumes its own conversation rather than starting over.
          const run = await runAgent(
            {
              history: resuming ? [...priorEvents, initial] : [initial],
              userText: resuming ? initialText : objective,
            },
            makeDeps(effectiveMaxSteps ?? 0),
          );
          reachedTurnBudget = run.reachedTurnBudget === true;
        } catch (err) {
          threw = err as Error;
        }
        outcome = threw
          ? { ok: false, steps: 0, conclusion: `### Blocker\nSub-agent run threw: ${threw.message}` }
          : assessSubagentOutcome(events);

        const lastAttempt = attempt === maxSubAttempts - 1;
        const failureText = threw ? threw.message : outcome.conclusion;
 // Retry only transient failures, and only if we have attempts left.
        if (outcome.ok || lastAttempt || !isTransientError(failureText)) break;
        const delayMs = Math.min(8000, 1500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, delayMs));
      }

      // When a finite maxSteps/maxTurns was set and the run hit it, ask the
      // user whether to append more turns instead of failing or stopping cold.
      // Headless sessions (no onAskUser) keep the soft-landed conclusion.
      if (
        reachedTurnBudget &&
        typeof effectiveMaxSteps === "number" &&
        effectiveMaxSteps > 0 &&
        opts.onAskUser
      ) {
        let extensions = 0;
        while (extensions < MAX_BUDGET_EXTENSIONS) {
          const decision = await askBudgetExtension(opts.onAskUser, {
            objective,
            stepsUsed: outcome.steps,
            cap: effectiveMaxSteps,
            hasConclusion: outcome.ok,
          });
          if (decision.kind === "stop") break;
          extensions += 1;
          const extraTurns = decision.kind === "unlimited" ? 0 : decision.turns;
          const continueText =
            `<subagent_budget_continue extension="${extensions}">\n` +
            `The user approved continuing past the previous turn budget of ${effectiveMaxSteps}. ` +
            (extraTurns === 0
              ? `You have no new turn limit — finish the objective, then write your structured conclusion.`
              : `You have up to ${extraTurns} additional turns. Prefer finishing within that; synthesize a conclusion before the new cap.`) +
            `\nResume from what you already gathered; do not restart the whole exploration.\n` +
            `</subagent_budget_continue>`;
          try {
            const run = await runAgent(
              { history: events.slice(), userText: continueText },
              makeDeps(extraTurns),
            );
            reachedTurnBudget = run.reachedTurnBudget === true;
          } catch (err) {
            outcome = {
              ok: false,
              steps: outcome.steps,
              conclusion: `### Blocker\nSub-agent budget-continue threw: ${(err as Error).message}`,
            };
            break;
          }
          outcome = assessSubagentOutcome(events);
          if (!reachedTurnBudget) break;
        }
      }

 // Replay the adopted attempt's events to the external listener so the
 // host sees exactly one clean run (failed attempts are not forwarded).
      if (onEvent) for (const e of events) onEvent(e);

      let finalText = outcome.conclusion;
 // When a structured output was requested, extract + validate the JSON
 // so the parent receives a clean fenced block (or a clear error).
 // Skip schema validation on hard failures — the blocker text is not JSON.
      if (outputSchema && outcome.ok) {
        const parsed = extractStructuredJson(finalText);
        if (parsed.ok) {
          finalText = "```json\n" + JSON.stringify(parsed.value, null, 2) + "\n```";
        } else {
          finalText =
            `(sub-agent did not return valid JSON matching the schema: ${parsed.error})\n\n` +
            `Raw conclusion:\n${finalText}`;
          outcome = { ...outcome, ok: false, conclusion: finalText };
        }
      }
 // Append a worktree diff stat to the conclusion so the parent knows
 // what the isolated sub-agent changed (and where to find it).
      if (worktreeHandle) {
        const stat = await worktreeDiffStat(worktreeHandle);
        if (stat.length > 0) {
          finalText +=
            `\n\n[worktree changes — branch ${worktreeHandle.branch}]\n` +
            `${stat}`;
        } else {
          finalText +=
            `\n\n[worktree: no changes on branch ${worktreeHandle.branch}]`;
        }
      } else if (isolationFellBack) {
 // Worktree isolation was requested but could not be provided (e.g.
 // git unavailable in a sandbox). Make this loud in the conclusion so
 // the parent knows the sub-agent's edits landed directly in the
 // working tree and may collide with parallel siblings.
        finalText +=
          `\n\n⚠️ [isolation fell back to parent cwd] worktree isolation was requested but ` +
          `unavailable, so this sub-agent ran in ${effectiveCwd}. Any file edits are NOT ` +
          `isolated — if this was part of a parallel fan-out, verify no two sub-agents wrote ` +
          `the same files.`;
      }
 // SubagentStop: can block like Stop; continue the sub-agent with feedback.
      const stopType = custom?.name ?? effectiveType;
      const stopCap =
        typeof opts.config.stopHookBlockCap === "number" && opts.config.stopHookBlockCap >= 0
          ? opts.config.stopHookBlockCap
          : 8;
      let stopContinueCount = 0;
      let stopHookActive = false;
      while (opts.hooks && outcome.ok) {
        const stopResult = await opts.hooks
          .runSubagentStop(stopType, finalText, {
            stop_hook_active: stopHookActive,
            stop_continue_count: stopContinueCount,
            stop_continue_cap: stopCap,
          })
          .catch(() => ({ action: "allow" as const, warnings: [] as string[] }));

        if (stopResult.action !== "block") break;

        if (stopContinueCount >= stopCap) {
          finalText +=
            `\n\n[SubagentStop kept blocking after ${stopCap} continue(s); returning as-is.]`;
          break;
        }

        stopContinueCount += 1;
        stopHookActive = true;
        const reason =
          stopResult.reason?.trim() ||
          "SubagentStop blocked ending without a reason.";
        const continueText =
          `<subagent_stop_continue count="${stopContinueCount}" cap="${stopCap}">\n` +
          `${reason}\n` +
          `Address this feedback and produce an updated conclusion.\n` +
          `</subagent_stop_continue>`;

        try {
          await runAgent(
            { history: events.slice(), userText: continueText },
            makeDeps(effectiveMaxSteps ?? 0),
          );
        } catch (err) {
          outcome = {
            ok: false,
            steps: outcome.steps,
            conclusion: `### Blocker\nSub-agent continue threw: ${(err as Error).message}`,
          };
          finalText = outcome.conclusion;
          break;
        }
        outcome = assessSubagentOutcome(events);
        finalText = outcome.conclusion;
        if (outputSchema && outcome.ok) {
          const parsed = extractStructuredJson(finalText);
          if (parsed.ok) {
            finalText = "```json\n" + JSON.stringify(parsed.value, null, 2) + "\n```";
          }
        }
      }
      // Persist this run's transcript so the sub-agent can be continued later
      // (and so an interrupted in-flight run survives). A fresh run replaces the
      // file with [initial follow-up, …adopted events]; a resume appends the new
      // follow-up + events after the prior transcript. Best-effort.
      if (store) {
        const runEvents: Event[] = [initial, ...events];
        if (resuming) await store.appendAll(subagentOwnerId, runEvents);
        else await store.replace(subagentOwnerId, runEvents);
      }
      return {
        conclusion: finalText,
        steps: outcome.steps,
        ok: outcome.ok,
        usage: sumUsageFromEvents(events),
        sessionId: subagentOwnerId,
      };
      } finally {
 // Always clean up the worktree (forced removal). The diff stat was
 // already appended to the conclusion above, so the parent has a
 // record of what changed. We keep the branch only if the sub-agent
 // produced commits — detected by comparing HEAD vs the base ref.
        if (worktreeHandle) {
          let keepBranch = false;
          try {
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileP = promisify(execFile);
            const { stdout: headSha } = await execFileP(
              "git",
              ["rev-parse", "HEAD"],
              { cwd: worktreeHandle.path, timeout: 5000 }
            );
            const { stdout: baseSha } = await execFileP(
              "git",
              ["rev-parse", worktreeHandle.baseRef],
              { cwd: worktreeHandle.repoRoot, timeout: 5000 }
            );
            keepBranch = headSha.trim() !== baseSha.trim();
          } catch {
            keepBranch = false;
          }
          await removeWorktree(worktreeHandle, { keepBranch }).catch(() => undefined);
        }
      }
    },
  };
}

/**
 * The footer injected into the sub-agent's user message. Reinforces the
 * role boundary right before the model starts reasoning.
 */
const SUBAGENT_OBJECTIVE_FOOTER = `This is your only task. When you are done, your final assistant message must follow the structured conclusion format described in your system prompt (### Findings / ### Key references / ### Recommendations, or ### Blocker if blocked). Do not produce any other output.`;

/** Instruction block appended to the role when an output schema is
 * requested. Overrides the free-text conclusion format. */
function structuredOutputBlock(schema: Record<string, unknown>): string {
  return `\n\n## Structured Output\n\nYou have been asked to return a STRUCTURED result. Your final assistant message must be a SINGLE JSON object matching this JSON schema — no markdown, no prose, no code fence, just the JSON:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n\nIf you cannot complete the work, return \`{"error": "<one-sentence reason>"}\`. Do not include any text before or after the JSON object.`;
}

const STRUCTURED_OUTPUT_FOOTER = `This is your only task. Your final assistant message must be a single JSON object matching the schema in your system prompt — no markdown, no prose, just the JSON.`;

/** Extract a JSON object from the sub-agent's final text. Tolerates leading
 * whitespace, a surrounding ```json fence, and trailing prose. Returns
 * {ok, value} on success or {ok:false, error} on failure. */
function extractStructuredJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
 // Try direct parse first.
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
 /* fall through */
  }
 // Try a fenced ```json ... ``` block.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return { ok: true, value: JSON.parse(fenced[1]!.trim()) };
    } catch {
 /* fall through */
    }
  }
 // Try the first {...} balanced span.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
    } catch {
 /* fall through */
    }
  }
  return { ok: false, error: "no JSON object found in the conclusion" };
}

const NO_FINAL_TEXT = "(sub-agent produced no final text)";

type BudgetExtensionDecision =
  | { kind: "stop" }
  | { kind: "unlimited" }
  | { kind: "more"; turns: number };

/**
 * Ask the user whether to extend a capped sub-agent. Returns stop when the
 * channel is missing, the user declines, or the answer is unparseable.
 */
export async function askBudgetExtension(
  onAskUser: NonNullable<AgentDeps["onAskUser"]>,
  ctx: {
    objective: string;
    stepsUsed: number;
    cap: number;
    hasConclusion: boolean;
  },
): Promise<BudgetExtensionDecision> {
  const snippet =
    ctx.objective.length > 240 ? `${ctx.objective.slice(0, 240)}…` : ctx.objective;
  const answers: QuestionAnswers = await onAskUser({
    requestId: `subagent_budget_${randomUUID().slice(0, 8)}`,
    questions: [
      {
        id: "continue",
        header: "Sub-agent turn budget",
        question:
          `A sub-agent reached its turn budget (${ctx.cap}` +
          (ctx.stepsUsed > 0 ? `, ${ctx.stepsUsed} tool step(s) so far` : "") +
          `). Objective:\n${snippet}\n\n` +
          (ctx.hasConclusion
            ? "It produced a partial conclusion. Continue so it can dig further?"
            : "It has not finished synthesizing. Continue so it can complete the work?"),
        options: [
          {
            label: `Continue (+${ctx.cap} turns)`,
            description: `Grant another ${ctx.cap} turns, then ask again if still not done.`,
          },
          {
            label: "Continue (no limit)",
            description: "Let it run without a new turn cap until it finishes or you cancel.",
          },
          {
            label: "Stop",
            description: "Keep the current conclusion and return to the parent agent.",
          },
        ],
      },
    ],
  });
  return parseBudgetExtensionAnswer(answers.continue, ctx.cap);
}

/** Pure parser for tests / hosts that want to pre-resolve the choice. */
export function parseBudgetExtensionAnswer(
  raw: string | string[] | undefined,
  cap: number,
): BudgetExtensionDecision {
  const text = (Array.isArray(raw) ? raw.join(" ") : raw ?? "").trim().toLowerCase();
  if (!text) return { kind: "stop" };
  // Match specific options before the bare "stop" label — "Continue (+N turns)"
  // must not be classified as stop.
  if (text.includes("no limit") || text.includes("unlimited") || /不限|无限制/.test(text)) {
    return { kind: "unlimited" };
  }
  if (text.includes("continue") || /继续|追加/.test(text)) {
    return { kind: "more", turns: Number.isFinite(cap) && cap > 0 ? cap : 15 };
  }
  if (/^stop\b/.test(text) || text === "stop" || /停止|结束|不要/.test(text)) {
    return { kind: "stop" };
  }
  return { kind: "stop" };
}

function extractFinalText(events: Event[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "message" && e.role === "assistant") {
      const text = e.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return NO_FINAL_TEXT;
}

function extractErrors(events: Event[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "error" && e.message.trim()) out.push(e.message.trim());
  }
  return out;
}

function countSteps(events: Event[]): number {
  let n = 0;
  for (const e of events) if (e.type === "tool_call") n++;
  return n;
}

// Output degeneration detectors live in a standalone module (no agent/session
// deps) so the live streaming loop can use them too without a circular import.
// Re-exported here to preserve the existing public import surface.
export { detectDegenerateText, detectRunawayRepetition };

/**
 * Decide whether a sub-agent run produced a usable conclusion.
 *
 * Soft failures (provider 404, empty stream, aborted mid-turn with no
 * text) are surfaced as errors with `ok: false` rather than as successful
 * `0 steps` / "no final text" results, so the parent does not keep
 * exploring a failed sub-agent.
 */
export function assessSubagentOutcome(events: Event[]): {
  conclusion: string;
  steps: number;
  ok: boolean;
} {
  const steps = countSteps(events);
  const errors = extractErrors(events);
  const text = extractFinalText(events);
  const hasText = text !== NO_FINAL_TEXT;

  // Degenerate output (decoding collapse) is a failure, never a conclusion.
  // Caught before the "has text → ok" path so the garbage is not adopted or
  // fed back to the parent. Guards the "乱说 / incoherent garbage" form.
  if (hasText) {
    const degen = detectDegenerateText(text);
    if (degen) {
      return {
        ok: false,
        steps,
        conclusion:
          `### Blocker\n` +
          `Sub-agent output degenerated into repeated noise ` +
          `(the unit ${JSON.stringify(degen.unit)} covers ` +
          `${Math.round(degen.ratio * 100)}% of ${text.length} chars) ` +
          `after ${steps} tool step(s). The model collapsed into a decode loop ` +
          `instead of producing a conclusion — treat this run as failed and ` +
          `retry (optionally with a stronger model or a narrower objective).`,
      };
    }
    // Zero tool steps is a failure for an agentic sub-agent, regardless of what
    // text it emitted. A sub-agent's job is to DO work (read/search/run) and
    // then report; text produced without any tool call is an announcement of
    // intent ("I'll read the files…"), not a result. Adopting it credits the
    // child with work it never did. Borrowed from dsh's hard guard
    // (packages/goal activation.ts): "completed" with no captured work is
    // forced to error. We key off the real signal (step count), not a fragile
    // text-pattern match, so it is model- and language-agnostic. Guards the
    // "提前结束 / premature termination" form.
    if (steps === 0) {
      const snippet = text.length > 160 ? `${text.slice(0, 160)}…` : text;
      return {
        ok: false,
        steps,
        conclusion:
          `### Blocker\n` +
          `Sub-agent produced text but took 0 tool steps — it never read, ` +
          `searched, or ran anything, so it did no real work (the output is an ` +
          `announcement of intent, not a finding). Treat this run as failed and ` +
          `retry.\n\nWhat it said:\n${JSON.stringify(snippet)}`,
      };
    }
  }

  if (errors.length > 0 && !hasText) {
    return {
      ok: false,
      steps,
      conclusion:
        `### Blocker\n` +
        `Sub-agent failed before producing a conclusion` +
        (steps === 0 ? " (0 tool steps)." : ` (${steps} tool step(s) before failure).`) +
        `\n\nProvider/runtime errors:\n` +
        errors.map((m) => `- ${m}`).join("\n"),
    };
  }

  if (!hasText) {
    return {
      ok: false,
      steps,
      conclusion:
        `### Blocker\n` +
        `Sub-agent produced no final text` +
        (steps === 0
          ? " and took 0 tool steps — the model likely returned an empty/error response."
          : ` after ${steps} tool step(s).`),
    };
  }

  if (errors.length > 0) {
 // Model recovered enough to write a conclusion; keep ok but append errors
 // so the parent can see transient failures that happened mid-run.
    return {
      ok: true,
      steps,
      conclusion:
        text +
        `\n\n(note: sub-agent also recorded error event(s):\n` +
        errors.map((m) => `- ${m}`).join("\n") +
        `)`,
    };
  }

  return { ok: true, steps, conclusion: text };
}

function joinCodepilot(cwd: string, sub: string): string {
  return projectStatePath(cwd, sub);
}

/** A requested model id, unless the active preset lists its models and this
 * one is not among them (the endpoint would reject it). */
function pickServedModel(opts: SubagentFactoryOptions, requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const presets = (opts.config as { providers?: Record<string, { models?: string[]; baseURL?: string }> }).providers ?? {};
  const active = Object.values(presets).find((p) => p.baseURL && p.baseURL === opts.config.baseURL);
  if (active?.models && active.models.length > 0 && !active.models.includes(requested)) return undefined;
  return requested;
}
