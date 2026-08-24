package io.codepilot.harness.subagent

/**
 * Spec for spawning a sub-agent: an independent harness run with a restricted
 * tool catalog and an explicit token ceiling.
 *
 * Sub-agents are the first-line context-management tool (cf. Cursor Tasks /
 * Claude Code subagents): instead of compacting, isolate. The sub-agent runs
 * in its own session, cannot spawn further sub-agents (to prevent recursion),
 * and only the final summary is returned to the parent — the parent's context
 * never sees the sub-agent's intermediate tool results.
 */
data class SubagentSpec(
    /** Human-readable label, surfaced in the parent's tool result. */
    val name: String,
    /** The goal handed to the sub-agent. Should be narrowly scoped. */
    val goal: String,
    /** Whitelist of tool names the sub-agent may use; empty = inherit parent catalog minus subagent. */
    val allowedTools: Set<String> = emptySet(),
    /** Max turns the sub-agent may take. */
    val maxSteps: Int = 12,
    /** Max tokens the sub-agent may consume (best-effort, enforced via ChatRequest.maxTokens). */
    val maxTokens: Int? = null,
    /** System prompt preamble specific to this sub-agent (appended to identity). */
    val preamble: String = "",
)
