package io.codepilot.plugin.protocol

/**
 * Structured event envelope sent from plugin to WebUI as a single unified channel.
 *
 * All UI state transitions in the new v2 protocol are driven exclusively by these
 * envelopes. Each envelope carries (seq, turnId, stepId) for ordering, attribution
 * and gap detection. See doc/01-event-protocol.md for the full specification.
 *
 * NOTE: This v2 protocol runs in parallel with the legacy event channel
 * (delta / tool_call / done / agent_*). The legacy channel is kept intact for
 * backward compatibility; v2 is opt-in via the WebUI flag
 * localStorage['codepilot.protocol.v2'] === '1'. Once the v2 UI is verified,
 * the legacy channel can be removed.
 */
data class EventEnvelope(
    val seq: Long,
    val turnId: String,
    val stepId: String,
    val parentStepId: String? = null,
    val ts: Long,
    val type: String,
    val payload: Any? = null,
)

/** Step kinds used in step.start events. */
object StepKinds {
    const val LLM = "llm"
    const val THINKING = "thinking"
    const val TOOL = "tool"
    const val PLAN = "plan"
    const val SUBTASK = "subtask"
}

/** Turn statuses used in turn.end events. */
object TurnStatuses {
    const val FINAL = "final"
    const val FAILED = "failed"
    const val STOPPED = "stopped"
    const val INTERRUPTED = "interrupted"
    const val MAX_STEPS = "max_steps"
}

/** Step statuses used in step.end events. */
object StepStatuses {
    const val SUCCESS = "success"
    const val ERROR = "error"
    const val CANCELLED = "cancelled"
}

/** Event types. Kept as constants to avoid stringly-typed mistakes at call sites. */
object EventTypes {
    // turn lifecycle
    const val TURN_START = "turn.start"
    const val TURN_END = "turn.end"

    // step lifecycle
    const val STEP_START = "step.start"
    const val STEP_PROGRESS = "step.progress"
    const val STEP_END = "step.end"

    // text streams (attached to a step)
    const val TEXT_DELTA = "text.delta"
    const val TEXT_THINKING = "text.thinking"

    // tool calls (the step itself is a tool step)
    const val TOOL_CALL = "tool.call"
    const val TOOL_PROGRESS = "tool.progress"
    const val TOOL_RESULT = "tool.result"

    // plan
    const val PLAN_UPDATE = "plan.update"

    // user interaction
    const val NEEDS_INPUT = "needs_input"
    const val RISK_NOTICE = "risk_notice"

    // P0-03 hunk-apply staging
    const val PENDING_UPDATE = "pending.update"
    const val APPLY_RESULT = "apply.result"

    // P0-04 inline edit (Cmd+K) and Tab completion telemetry
    const val INLINE_OPEN = "inline.open"
    const val INLINE_DELTA = "inline.delta"
    const val INLINE_DONE = "inline.done"
    const val INLINE_ACCEPT = "inline.accept"
    const val INLINE_REJECT = "inline.reject"
    const val INLINE_ERROR = "inline.error"
    const val TAB_SUGGEST = "tab.suggest"
    const val TAB_ACCEPT = "tab.accept"
    const val TAB_DISMISS = "tab.dismiss"

    // P1-05 codebase index and search
    const val CODEBASE_STATUS = "codebase.status"
    const val CODEBASE_SEARCH_RESULT = "codebase.search.result"

    // P1-06 rules / memories
    const val RULES_LOADED = "rules.loaded"
    const val MEMORY_UPDATE = "memory.update"

    // P1-07 MCP / hooks
    const val MCP_STATUS = "mcp.status"
    const val HOOK_RESULT = "hook.result"

    // P1-08 shell policy and streaming
    const val SHELL_ASK = "shell.ask"
    const val SHELL_PROGRESS = "shell.progress"
}
