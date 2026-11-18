// Sub-agent runner: a thin wrapper around `runAgent` that runs with a fresh
// Sub-agent runner: a child agent with its own transcript and restricted tool
// set that returns only the final text. Built on the shared system prompt with
// an added scope-bounding block (focused worker, returns a structured conclusion).

import { randomUUID } from "node:crypto";
import { runAgent, type AgentDeps, isTransientError } from "../agent/agent.js";
import { trimEventsToBudget } from "../compaction/compaction.js";
import type { CodepilotConfig, Event, UsageInfo } from "../types.js";
import { ToolRegistry } from "../tools/types.js";
import { ArtifactStore } from "../tools/artifacts.js";
import { PermissionEngine } from "../permissions/permissions.js";
import { buildProvider } from "../session/session-utils.js";
import { buildSystemPrompt } from "../systemPrompt/index.js";
import { type MemoryContents, readMemory, readProjectInstructions, summariseMemory } from "../memory/memory.js";
import { resolveSandbox, cloneSandbox, addWritableRoot } from "../sandbox/sandbox.js";
import type { SubagentRunner } from "../tools/task.js";
import { createWorktree, removeWorktree, worktreeDiffStat, attachWorktree } from "../workspace/worktree.js";
import { projectStatePath } from "../workspace/projectState.js";
import { SubagentStore } from "./subagentStore.js";
import {
  assessSubagentOutcome,
  extractStructuredJson,
  structuredOutputBlock,
  STRUCTURED_OUTPUT_FOOTER,
} from "./outcome.js";
import {
  DEFAULT_FORK_MAX_TOKENS,
  FORK_CONTEXT_MARKER,
  SUBAGENT_OBJECTIVE_FOOTER,
  SUBAGENT_PLAN_FOOTER,
} from "./prompts.js";

/**
 * Decide the PermissionEngine a sub-agent runs under: a fresh independent
 * engine when the custom agent declares its own permissionMode, there is no
 * parent, or config `subagentPermissions: "independent"`; "inherit" shares the
 * parent engine.
 */
export function resolveSubagentPermissions(args: {
  parent?: PermissionEngine;
  customPermissionMode?: import("../types.js").PermissionMode;
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

/**
 * Re-anchor a worktree sub-agent's sandbox and delivery roots to the worktree
 * path (it lives outside the parent cwd). The sandbox is CLONED so the parent's
 * policy is never widened; the worktree is prepended to delivery roots.
 */
export function resolveWorktreeRoots(args: {
  worktreePath: string;
  baseSandbox: import("../sandbox/sandbox.js").ResolvedSandbox;
  parentDeliveryRoots: readonly string[];
}): { sandbox: import("../sandbox/sandbox.js").ResolvedSandbox; deliveryRoots: string[] } {
  const { worktreePath, baseSandbox, parentDeliveryRoots } = args;
  const sandbox = cloneSandbox(baseSandbox);
  addWritableRoot(sandbox, worktreePath);
  const deliveryRoots = parentDeliveryRoots.includes(worktreePath)
    ? [...parentDeliveryRoots]
    : [worktreePath, ...parentDeliveryRoots];
  return { sandbox, deliveryRoots };
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
 /** Parent's structured question channel (tool asks / permission follow-ups).
  * Turn-budget extension is not user-asked — the parent resumes via
  * continue_session_id when more work is needed. */
  onAskUser?: AgentDeps["onAskUser"];
 /** Live parent sandbox (so expand-dir grants apply to sub-agents too). */
  getSandbox?: () => import("../sandbox/sandbox.js").ResolvedSandbox;
  expandSandboxWritable?: AgentDeps["expandSandboxWritable"];
 /** Inherit parent's delivery roots / scratch so worker writes stay on-task. */
  getDeliveryRoots?: () => string[];
  addDeliveryRoot?: AgentDeps["addDeliveryRoot"];
  scratchDir?: () => string | undefined;
  projectStateDir?: () => string | undefined;
 /** Parent session artifact store. When set, sub-agents (including worktree
  * isolation) write/read the same content-addressed store so `art_*` refs in
  * the conclusion remain readable by the parent. */
  getArtifacts?: () => ArtifactStore;
 /** Snapshot of the parent's model-visible events, used to seed a `context:
  * "fork"` sub-agent (trimmed + prepended before the objective). Omitted means
  * forking is unavailable; the sub-agent runs fresh. */
  getParentEvents?: () => Event[];
 /** Build the tool registry for the given agent type. */
  buildToolRegistry: (agentType?: "explore" | "plan" | "worker") => ToolRegistry;
 /** Optional hook engine to fire SubagentStop events (may block + continue). */
  hooks?: {
    runSubagentStop: (
      agentType: string,
      conclusion: string,
      extra?: Record<string, unknown>,
    ) => Promise<{ action: "allow" | "block"; reason?: string; warnings: string[] }>;
  };
 /**
 * Optional resolver for custom agents (`.codepilot/agents/*.md`). Called for
 * an `agentType` that isn't a built-in; returns undefined for unknown names
 * (runner falls back to "explore").
 */
  resolveCustomAgent?: (name: string) => Promise<import("../skills/customAgents.js").CustomAgent | undefined>;
  /** Post-write formatting + diagnostics, shared with the parent session. */
  postWrite?: AgentDeps["postWrite"];
}

export function createSubagentRunner(
  factoryOpts: SubagentFactoryOptions
): SubagentRunner {
  return {
    async run({ objective, cwd, agentType, tools, model, maxSteps, onEvent, onLiveEvent, depth, outputSchema, isolation, resumeSessionId, continueText, ownerId, sharedWorktreePath, context, forkMaxTokens, omitMemory, signal }) {
      const live = factoryOpts.getEndpoint?.();
      const opts: SubagentFactoryOptions = live
        ? { ...factoryOpts, config: live.config, model: live.model }
        : factoryOpts;
 // Resolve a custom agent definition when the type isn't a built-in.
      const isBuiltin =
        agentType === "explore" ||
        agentType === "plan" ||
        agentType === "worker" ||
        agentType === undefined;
      const custom = !isBuiltin && opts.resolveCustomAgent
        ? await opts.resolveCustomAgent(agentType!).catch(() => undefined)
        : undefined;
 // The requested built-in type, before it is collapsed to a tool surface.
 // "plan" shares explore's read-only surface but gets its own role/footer.
      const isPlan = agentType === "plan" && !custom;
 // Effective type: custom agents use "worker" as the base tool surface
 // (so their frontmatter `tools` allowlist can narrow it); unknown
 // custom names fall back to "explore". "plan" maps to the read-only surface.
      const effectiveType: "explore" | "worker" = custom ? "worker" : (agentType === "worker" ? "worker" : "explore");
      const effectiveModel =
        pickServedModel(opts, model) ??
        pickServedModel(opts, custom?.model) ??
        pickServedModel(opts, opts.config.smallModel) ??
        opts.model;
      // Unset = unlimited (doom-loop / cancel / timeout still apply). Only cap
      // when the parent `task` call or custom-agent frontmatter sets a value.
      const effectiveMaxSteps = maxSteps ?? custom?.maxTurns;

 // Filesystem isolation: when `isolation === "worktree"`, run the sub-agent
 // in a linked git worktree on a fresh branch. Falls back to the parent cwd
 // if git is unavailable — best-effort, never a hard requirement.
      // Unique owner id so `write_stdin` refuses cross-agent writes (critical
      // when worktree isolation falls back to a shared cwd). Prefer the
      // `task`-assigned id; a resume reuses the prior; otherwise mint one.
      const subagentOwnerId = ownerId ?? resumeSessionId ?? `sub_${randomUUID()}`;
      const isResume = Boolean(resumeSessionId);
      let worktreeHandle: import("../workspace/worktree.js").WorktreeHandle | null = null;
      let effectiveCwd = cwd;
      let isolationNote = "";
      let isolationFellBack = false;
      // When worktree isolation succeeds, the sub-agent's cwd moves outside the
      // parent cwd, so its sandbox/delivery roots must be re-anchored there
      // explicitly (the parent's roots don't cover it). Undefined unless a
      // worktree is actually created.
      let worktreeSandbox: import("../sandbox/sandbox.js").ResolvedSandbox | undefined;
      let worktreeDeliveryRoots: string[] | undefined;
      // Durable transcript store: persists this sub-agent's replayable events
      // (so it can be CONTINUED) and a small meta sidecar (e.g. which worktree it
      // ran in, so a continue re-attaches to that checkout).
      const stateDir = opts.projectStateDir?.();
      const store = stateDir ? new SubagentStore(stateDir) : null;
      // A worktree we re-attached to on a continue; its working tree must NOT be
      // torn down in the finally block (we want to continue in it again).
      let reusedWorktree = false;
      if (isolation === "worktree") {
        // On a continue, try to re-attach to the sub-agent's prior worktree so it
        // resumes on its own branch (with earlier commits) rather than branching
        // from a fresh HEAD. Falls through to a fresh worktree if unavailable.
        let reattached = false;
        if (isResume && store) {
          const meta = await store.loadMeta(subagentOwnerId);
          if (meta.worktree) {
            const att = await attachWorktree(meta.worktree);
            if (att.ok) {
              worktreeHandle = att.worktree;
              effectiveCwd = att.worktree.path;
              reusedWorktree = att.reused;
              reattached = true;
              const reanchored = resolveWorktreeRoots({
                worktreePath: effectiveCwd,
                baseSandbox: opts.getSandbox?.() ?? resolveSandbox(opts.config.sandbox, cwd),
                parentDeliveryRoots: opts.getDeliveryRoots?.() ?? [],
              });
              worktreeSandbox = reanchored.sandbox;
              worktreeDeliveryRoots = reanchored.deliveryRoots;
              isolationNote =
                `\n\n[worktree isolation] You are continuing in your prior git worktree.\n` +
                `  path: ${att.worktree.path}\n  branch: ${att.worktree.branch}\n` +
                `  base: ${att.worktree.baseRef}\n` +
                `Your earlier changes on this branch are present. Edits land in this isolated ` +
                `checkout and do NOT affect the parent's working tree.`;
            }
          }
        }
        if (!reattached) {
          const wt = await createWorktree({
            cwd,
            label: custom?.name ?? agentType ?? "subagent",
          });
          if (wt.ok) {
            worktreeHandle = wt.worktree;
            effectiveCwd = wt.worktree.path;
            const reanchored = resolveWorktreeRoots({
              worktreePath: effectiveCwd,
              baseSandbox: opts.getSandbox?.() ?? resolveSandbox(opts.config.sandbox, cwd),
              parentDeliveryRoots: opts.getDeliveryRoots?.() ?? [],
            });
            worktreeSandbox = reanchored.sandbox;
            worktreeDeliveryRoots = reanchored.deliveryRoots;
            isolationNote =
              `\n\n[worktree isolation] You are running in a linked git worktree.\n` +
              `  path: ${wt.worktree.path}\n  branch: ${wt.worktree.branch}\n` +
              `  base: ${wt.worktree.baseRef}\n` +
              `Your edits land in this isolated checkout and do NOT affect the parent's working tree. ` +
              `The worktree is removed automatically when you finish; if you produce commits the branch is kept for the parent to merge.`;
          } else {
 // Fall back to the parent cwd. Surface the reason prominently — a parallel
 // fan-out that silently got no isolation can have two workers writing the
 // SAME files in the parent tree.
            isolationFellBack = true;
            isolationNote =
              `\n\n⚠️ [worktree isolation UNAVAILABLE] requested isolation could not be set up ` +
              `(${wt.reason} — ${wt.message}). You are running directly in the parent's working ` +
              `tree (${cwd}). If other sub-agents are running in parallel, DO NOT assume your ` +
              `file writes are isolated — coordinate or avoid editing the same files, and report ` +
              `exactly which files you changed in your conclusion.`;
          }
        }
        // Record the worktree so a later continue can re-attach to it.
        if (worktreeHandle && store) {
          await store.saveMeta(subagentOwnerId, {
            worktree: {
              path: worktreeHandle.path,
              branch: worktreeHandle.branch,
              baseRef: worktreeHandle.baseRef,
              repoRoot: worktreeHandle.repoRoot,
            },
          });
        }
      }

      // A shared worktree supplied by the caller (team `shared_worktree`): run
      // inside it, re-anchoring sandbox/delivery roots (same as the
      // `isolation: "worktree"` path). Skipped when the isolation path already
      // created a worktree.
      if (!worktreeHandle && sharedWorktreePath && sharedWorktreePath.trim().length > 0) {
        effectiveCwd = sharedWorktreePath;
        const reanchored = resolveWorktreeRoots({
          worktreePath: effectiveCwd,
          baseSandbox: opts.getSandbox?.() ?? resolveSandbox(opts.config.sandbox, cwd),
          parentDeliveryRoots: opts.getDeliveryRoots?.() ?? [],
        });
        worktreeSandbox = reanchored.sandbox;
        worktreeDeliveryRoots = reanchored.deliveryRoots;
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
      // Prefer the parent's store so worktree sub-agents' art_* refs stay
      // readable after the child ends. Fall back to a cwd-local store when the
      // host did not wire one (tests / standalone runners).
      const artifacts =
        opts.getArtifacts?.() ??
        new ArtifactStore(joinCodepilot(effectiveCwd, "artifacts"));
      await artifacts.init();
      const permissions = resolveSubagentPermissions({
        parent: opts.permissions,
        customPermissionMode: custom?.permissionMode,
        policy: opts.config.subagentPermissions,
        autoApprove: opts.config.autoApprove,
      });
 // Memory is read from the parent cwd — a worktree sub-agent should
 // still see project/user memory, but it writes artifacts into its own
 // isolated checkout. A `plan` sub-agent (or any caller passing omitMemory)
 // runs without the memory index so it reasons only from the objective and
 // what it reads.
      const memory: MemoryContents =
        omitMemory || isPlan ? {} : summariseMemory(await readMemory(cwd));
 // Workers that can mutate files need the repo's rules (test commands,
 // conventions). Explore/plan stay lean. A tools-narrowed worker with no
 // file mutators (e.g. bash-only network probes) skips AGENTS.md — peer
 // design: don't pay ~7k project instructions when the tool surface can't
 // use them. Full worker pool still injects.
      const FILE_MUTATORS = ["edit_file", "write_file", "apply_patch", "notebook_edit"] as const;
      const canMutateFiles = FILE_MUTATORS.some((n) => restricted.get(n) !== undefined);
      if (!omitMemory && !isPlan && effectiveType === "worker" && canMutateFiles) {
        const instructions = await readProjectInstructions(cwd, {
          walkToHome: opts.config.memory?.walkToHome === true,
          maxBytes: opts.config.memory?.instructionsMaxBytes,
        });
        if (instructions) memory.instructions = instructions;
      }
// Specialist roles get their own short templates instead of the parent block
// assembler. buildSystemPrompt({ subagent: true }) delegates to them.
      const subagentProfile = isPlan
        ? "plan"
        : effectiveType === "worker" || custom
          ? "worker"
          : "explore";
      const sys = await buildSystemPrompt({
        cwd: effectiveCwd,
        memory,
        toolNames: restricted.names(),
        sessionNotes: isolationNote || undefined,
        model: effectiveModel ?? opts.model,
        provider: opts.config.provider ?? "anthropic",
        mode: "agent",
        permissionMode: custom?.permissionMode ?? "auto-edit",
        subagent: true,
        subagentProfile,
        subagentCustomBody: custom?.body,
        subagentRoleAddon: outputSchema
          ? structuredOutputBlock(outputSchema)
          : undefined,
        scratchDir: opts.scratchDir?.(),
        projectStateDir: opts.projectStateDir?.(),
        deliveryRoots: opts.getDeliveryRoots?.() ?? [],
      });

      // Load a prior transcript when continuing an existing sub-agent.
      const priorEvents: Event[] = isResume && store ? await store.load(subagentOwnerId) : [];
      const resuming = isResume && priorEvents.length > 0;

      const userMessageId = `msg_${randomUUID()}`;
      const footer = outputSchema
        ? STRUCTURED_OUTPUT_FOOTER
        : isPlan
          ? SUBAGENT_PLAN_FOOTER
          : SUBAGENT_OBJECTIVE_FOOTER;
      // A resumed sub-agent already knows its role and prior context: send the
      // bare follow-up (no task/footer preamble). A fresh run gets the task text
      // + conclusion-format footer (no "OBJECTIVE:" label — peers send bare
      // delegation text; system prompt already names the task conceptually).
      const initialText = resuming
        ? (continueText ?? objective)
        : `${objective}\n\n${footer}`;
      const initial: Event = {
        type: "message",
        id: userMessageId,
        role: "user",
        content: [{ type: "text", text: initialText }],
      };
            // Live UI gets the task text only: the model prompt and the transcript
            // chrome are separate strings.
      // The conclusion/Blocker footer is model instruction — showing it in the
      // nested transcript as a raw user bubble confuses users and is not markdown.
      // `userAlreadyEmitted: true` still keeps the full footer on the model path.
      try {
        const uiText = resuming ? initialText : objective;
        onLiveEvent?.(
          uiText === initialText
            ? initial
            : {
                ...initial,
                content: [{ type: "text", text: uiText }],
              },
        );
      } catch {
        /* a UI listener must not break the run */
      }

      // Fork seed: when `context: "fork"` (and not resuming), inherit a trimmed
      // copy of the parent's model-visible history as a prefix (with a marker so
      // the sub-agent treats it as inherited context). Context-only — not
      // persisted into the sub-agent's transcript.
      let forkPrefix: Event[] = [];
      if (context === "fork" && !resuming) {
        const parentEvents = opts.getParentEvents?.() ?? [];
        if (parentEvents.length > 0) {
          const budget = forkMaxTokens ?? DEFAULT_FORK_MAX_TOKENS;
          const trimmed = trimEventsToBudget(parentEvents, budget, { keepRecentMessages: 6 });
          const marker: Event = {
            type: "message",
            id: `msg_${randomUUID()}`,
            role: "user",
            content: [{ type: "text", text: FORK_CONTEXT_MARKER }],
          };
          forkPrefix = [marker, ...trimmed.events];
        }
      }

 // Sub-agent retry: the whole sub-agent run is retried in place for
 // transient failures only (rate limit, dropped socket, gateway 5xx),
 // with exponential backoff. Deterministic failures (bad schema,
 // genuine blocker) are returned on the first attempt — retrying them
 // would just burn tokens.
      const maxSubAttempts = Math.max(1, opts.config.turnRetries ?? 2);
      let events: Event[] = [];
      const degenerationEnabled = opts.config.degeneration?.enabled !== false;
      let outcome = assessSubagentOutcome(events, { degenerationEnabled });
      let reachedTurnBudget = false;
      const makeDeps = (maxTurns: number): AgentDeps => ({
        provider,
        tools: restricted,
        artifacts,
        permissions,
        config: { ...opts.config, model: effectiveModel ?? opts.config.smallModel },
        cwd: effectiveCwd,
        sessionId: subagentOwnerId,
        // Same affinity key the parent session sets — without it, OpenAI /
        // CCR-compatible providers keep cache_read=0 across the child's own
        // multi-turn requests even when the system+tools prefix is stable.
        promptCacheKey: subagentOwnerId,
        systemPrompt: sys,
        // 0 = unlimited; must set explicitly so parent config.maxTurns is not inherited.
        maxTurns,
        isSubagent: true,
        // Wind-down / stall locks pick Findings vs Plan section headers from this.
        subagentProfile,
        // External abort wire (e.g. `subagent_interrupt` on a background run).
        // The agent loop honours this signal at every checkpoint.
        signal,
        // When a structured result is requested on an OpenAI-dialect provider,
        // additionally constrain output with native json_schema. The prompt+parse
        // path still runs, so this is a strict upgrade (native where available,
        // prompt-only elsewhere).
        responseFormat:
          outputSchema && provider.name === "openai"
            ? { name: "subagent_result", schema: outputSchema, strict: false }
            : undefined,
        sandbox: worktreeSandbox ?? opts.getSandbox?.() ?? resolveSandbox(opts.config.sandbox, effectiveCwd),
        expandSandboxWritable: opts.expandSandboxWritable,
        deliveryRoots: worktreeDeliveryRoots ?? opts.getDeliveryRoots?.() ?? [effectiveCwd],
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
        postWrite: opts.postWrite,
      });

      for (let attempt = 0; attempt < maxSubAttempts; attempt++) {
 // Fresh transcript per attempt — a half-finished prior attempt must
 // not leak into the retry's context or its outcome assessment.
        events = [];
        reachedTurnBudget = false;
        let threw: Error | null = null;
        try {
 // Prepend the initial event as history and set userAlreadyEmitted so
 // runAgent does not append a second copy of the same user text (bare
 // objective). When continuing, seed prior transcript the same way.
          const run = await runAgent(
            {
              history: resuming
                ? [...priorEvents, initial]
                : forkPrefix.length > 0
                  ? [...forkPrefix, initial]
                  : [initial],
              userText: initialText,
              userAlreadyEmitted: true,
            },
            makeDeps(effectiveMaxSteps ?? 0),
          );
          reachedTurnBudget = run.reachedTurnBudget === true;
        } catch (err) {
          threw = err as Error;
        }
        outcome = threw
          ? { ok: false, steps: 0, conclusion: `### Blocker\nSub-agent run threw: ${threw.message}` }
          : assessSubagentOutcome(events, { degenerationEnabled });

        const lastAttempt = attempt === maxSubAttempts - 1;
        const failureText = threw ? threw.message : outcome.conclusion;
 // Retry only transient failures, and only if we have attempts left.
        if (outcome.ok || lastAttempt || !isTransientError(failureText)) break;
        const delayMs = Math.min(8000, 1500 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, delayMs));
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
      const stopType = custom?.name ?? (isPlan ? "plan" : effectiveType);
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
        outcome = assessSubagentOutcome(events, {
          degenerationEnabled: opts.config.degeneration?.enabled !== false,
        });
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
      // Annotate after schema / worktree / SubagentStop so the parent always
      // sees the budget signal on the final handoff text.
      if (
        reachedTurnBudget &&
        typeof effectiveMaxSteps === "number" &&
        effectiveMaxSteps > 0
      ) {
        finalText +=
          `\n\n[turn budget reached: ${effectiveMaxSteps}` +
          (outcome.steps > 0 ? `, ${outcome.steps} tool step(s)` : "") +
          `. Parent: resume with continue_session_id if more work is needed; do not re-dispatch the same objective.]`;
      }
      return {
        conclusion: finalText,
        steps: outcome.steps,
        ok: outcome.ok,
        usage: sumUsageFromEvents(events),
        sessionId: subagentOwnerId,
        reachedTurnBudget,
      };
      } finally {
 // Always clean up the worktree (forced removal). The diff stat was
 // already appended to the conclusion above, so the parent has a
 // record of what changed. We keep the branch only if the sub-agent
 // produced commits — detected by comparing HEAD vs the base ref.
        if (worktreeHandle && !reusedWorktree) {
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