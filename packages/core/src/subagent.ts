// Sub-agent runner: a thin wrapper around `runAgent` that runs with a fresh
// transcript, a restricted tool set, and returns only the final text.
//
// The sub-agent gets its own system prompt built on top of the shared
// `buildSystemPrompt` static prefix, with an additional block that bounds
// its scope: it is a focused worker, it does not own the user's task, and
// it returns a structured conclusion.

import { randomUUID } from "node:crypto";
import { runAgent, type AgentDeps, isTransientError } from "./agent.js";
import type { CodepilotConfig, Event } from "./types.js";
import { ToolRegistry } from "./tools/types.js";
import { ArtifactStore } from "./tools/artifacts.js";
import { PermissionEngine } from "./permissions.js";
import { AnthropicProvider, OpenAIProvider, CopilotProvider } from "./providers/index.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { readMemory, summariseMemory } from "./memory.js";
import { resolveSandbox } from "./sandbox.js";
import type { SubagentRunner } from "./tools/task.js";
import type { ChatProvider } from "./providers/types.js";
import { createWorktree, removeWorktree, worktreeDiffStat } from "./worktree.js";
import { projectStatePath } from "./projectState.js";

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
- **Default tool surface is read-only** (agent type \`explore\`). You have \`read_file\`, \`grep\`, \`glob\`, \`ls\`, \`read_artifact\` (and any others the parent explicitly listed). If you are a \`worker\` sub-agent, you additionally have \`write_file\` / \`edit_file\` / \`bash\` — use them to complete the delegated change, and verify it (run the relevant test/build) before reporting. \`plan_update\` and \`memory_write\` are never available. If the parent asks you to "fix" or "implement" something but you lack write tools, say so in your conclusion and stop.
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
 /** Live parent sandbox (so expand-dir grants apply to sub-agents too). */
  getSandbox?: () => import("./sandbox.js").ResolvedSandbox;
  expandSandboxWritable?: AgentDeps["expandSandboxWritable"];
 /** Build the tool registry for the given agent type. */
  buildToolRegistry: (agentType?: "explore" | "worker") => ToolRegistry;
 /** Optional hook engine to fire SubagentStop events. */
  hooks?: { runSubagentStop: (agentType: string, conclusion: string) => Promise<{ warnings: string[] }>; };
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
    async run({ objective, cwd, agentType, tools, model, maxSteps, onEvent, onLiveEvent, depth, outputSchema, isolation }) {
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
      const effectiveMaxSteps = maxSteps ?? custom?.maxTurns ?? 15;

 // Filesystem isolation: when `isolation === "worktree"`, create a
 // linked git worktree on a fresh branch and run the sub-agent there.
 // Its edits land in an isolated checkout; we clean up (and surface a
 // diff stat) in the finally block below. Falls back to the parent cwd
 // if git is unavailable or worktree creation fails — isolation is a
 // best-effort feature, never a hard requirement.
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
      const provider = buildProvider(opts.config, effectiveModel);
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
      const permissions = custom?.permissionMode || !opts.permissions
        ? new PermissionEngine({
            permissionMode: custom?.permissionMode ?? "auto-edit",
            autoApprove: opts.config.autoApprove,
          })
        : opts.permissions;
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

      const userMessageId = `msg_${randomUUID()}`;
      const footer = outputSchema
        ? STRUCTURED_OUTPUT_FOOTER
        : SUBAGENT_OBJECTIVE_FOOTER;
      const initial: Event = {
        type: "message",
        id: userMessageId,
        role: "user",
        content: [
          { type: "text", text: `OBJECTIVE:\n${objective}\n\n${footer}` },
        ],
      };

 // Sub-agent retry: the parent agent loop regenerates a turn on a
 // transient stream failure, but a sub-agent used to get one shot — a
 // flaky provider (rate limit, dropped socket, gateway 5xx) turned into
 // a hard `ok:false` the parent had to notice and re-dispatch by hand.
 // We now retry the whole sub-agent run in place for transient failures
 // only, with exponential backoff. Deterministic failures (bad schema,
 // genuine blocker) are returned on the first attempt — retrying them
 // would just burn tokens.
      const maxSubAttempts = Math.max(1, opts.config.turnRetries ?? 2);
      let events: Event[] = [];
      let outcome = assessSubagentOutcome(events);
      for (let attempt = 0; attempt < maxSubAttempts; attempt++) {
 // Fresh transcript per attempt — a half-finished prior attempt must
 // not leak into the retry's context or its outcome assessment.
        events = [];
        const deps: AgentDeps = {
          provider,
          tools: restricted,
          artifacts,
          permissions,
          config: { ...opts.config, model: effectiveModel ?? opts.config.smallModel },
          cwd: effectiveCwd,
          systemPrompt: sys,
          maxTurns: effectiveMaxSteps,
          sandbox: opts.getSandbox?.() ?? resolveSandbox(opts.config.sandbox, effectiveCwd),
          expandSandboxWritable: opts.expandSandboxWritable,
          subagentDepth: (depth ?? 0) + 1,
          onEvent: async (e) => {
            if (e.type !== "activity") events.push(e);
            try { onLiveEvent?.(e); } catch { /* a UI listener must not break the run */ }
          },
          onPermissionRequest: opts.onPermissionRequest,
        };

        let threw: Error | null = null;
        try {
 // Prepend the initial event as history so runAgent doesn't double-emit it.
          await runAgent({ history: [initial], userText: objective }, deps);
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
 // Fire SubagentStop hook (matcher: agent_type). Fire-and-forget.
      const stopType = custom?.name ?? effectiveType;
      if (opts.hooks) {
        await opts.hooks.runSubagentStop(stopType, finalText).catch(() => undefined);
      }
      return { conclusion: finalText, steps: outcome.steps, ok: outcome.ok };
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

/**
 * Decide whether a sub-agent run produced a usable conclusion.
 *
 * Soft failures (provider 404, empty stream, aborted mid-turn with no text)
 * used to look like successful `0 steps` / "no final text" results and the
 * parent kept exploring. Surface the error and mark `ok: false` instead.
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

function buildProvider(config: CodepilotConfig, model: string | undefined): ChatProvider {
  const provider = config.provider ?? "anthropic";
  switch (provider) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        defaultModel: model,
        smallModel: model,
      });
    case "copilot":
      return new CopilotProvider({});
    case "anthropic":
    default:
      return new AnthropicProvider({
        apiKey: config.apiKey,
        defaultModel: model,
        smallModel: model,
      });
  }
}
