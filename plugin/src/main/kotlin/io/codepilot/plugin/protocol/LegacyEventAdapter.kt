package io.codepilot.plugin.protocol

import com.intellij.openapi.diagnostic.logger

/**
 * Stateful adapter that converts the existing per-event channel
 * (delta / tool_call / tool_result_ack / agent_thinking / agent_reading /
 * agent_writing / agent_running / user_plan / risk_notice / needs_input / done /
 * error) into structured [EventEnvelope]s emitted on the [EventBus].
 *
 * One instance per active turn. Holds the turn-local state required to allocate
 * step IDs and close the right step at the right time, without modifying the
 * ConversationClient SSE pipeline.
 *
 * Usage from CefChatPanel:
 *   val adapter = LegacyEventAdapter(bus, turnId)
 *   adapter.onTurnStart(userMessage, contextRefs)
 *   // …forward each legacy event…
 *   adapter.onTextDelta(text)
 *   adapter.onToolCall(toolCallId, toolName, args)
 *   adapter.onToolResultAck(toolCallId, ok)
 *   adapter.onDone(reason)
 */
class LegacyEventAdapter(
    private val bus: EventBus,
    val turnId: String,
) {
    private val log = logger<LegacyEventAdapter>()

    /** Current LLM step (auto-created on first text delta). */
    private var llmStepId: String? = null

    /** Tool steps keyed by toolCallId so we can close them on ack. */
    private val toolSteps = HashMap<String, String>()

    /** Per-tool-call captured info (name + args) so result classification can use args. */
    data class ToolCallInfo(val name: String, val args: com.fasterxml.jackson.databind.JsonNode?)

    private val toolCallInfos = HashMap<String, ToolCallInfo>()

    /** Last agent_* step id, for "previous-step-success" cascading. */
    private var lastAgentStepId: String? = null

    /** Monotonic counter for step IDs within this turn. */
    private var stepCounter = 0

    /** Whether endTurn() has already been emitted (idempotency). */
    private var ended = false

    private fun nextStepId(prefix: String): String {
        stepCounter += 1
        return "$turnId-$prefix-$stepCounter"
    }

    fun onTurnStart(userMessage: String, contextRefs: List<Map<String, Any?>>) {
        bus.startTurn(turnId, userMessage, contextRefs)
    }

    fun onTextDelta(text: String) {
        if (text.isEmpty()) return
        val sid =
            llmStepId ?: run {
                val s = nextStepId("llm")
                bus.startStep(turnId, s, StepKinds.LLM, "Reasoning")
                llmStepId = s
                s
            }
        bus.textDelta(turnId, sid, text)
    }

    fun onToolCall(toolCallId: String, toolName: String, args: com.fasterxml.jackson.databind.JsonNode?) {
        // close any in-flight LLM step textually but keep it open until turn end
        val sid = nextStepId("tool")
        toolSteps[toolCallId] = sid
        toolCallInfos[toolCallId] = ToolCallInfo(toolName, args)
        bus.startStep(turnId, sid, StepKinds.TOOL, toolName, parentStepId = llmStepId)
        bus.toolCall(turnId, sid, toolName, args, parentStepId = llmStepId)
    }

    /**
     * Map a legacy tool result ack into a structured v2 `tool.result` envelope.
     *
     * The classifier produces a payload with an explicit `kind` so WebUI components
     * can render rich previews (grep hits, shell terminal, file diff, …) without
     * brittle string-prefix checks.
     */
    fun onToolResultAck(
        toolCallId: String,
        ok: Boolean,
        result: Any? = null,
        error: String? = null,
        errorCode: String? = null,
    ) {
        val sid = toolSteps.remove(toolCallId) ?: run {
            log.debug("toolResultAck without matching tool.call: $toolCallId")
            return
        }
        val info = toolCallInfos.remove(toolCallId)
        val classified =
            info?.let {
                ToolResultClassifier.classify(it.name, it.args, ok, result, errorCode, error)
            } ?: mapOf("kind" to "unknown", "raw" to result)
        bus.toolResult(turnId, sid, ok, classified, error)
        bus.endStep(
            turnId, sid,
            if (ok) StepStatuses.SUCCESS else StepStatuses.ERROR,
            error,
        )
    }

    /** Map legacy agent_thinking → step.start(kind=thinking) and close prior agent step. */
    fun onAgentThinking(text: String?) =
        emitAgentStep(StepKinds.THINKING, text ?: "Thinking…", finalize = false)

    fun onAgentReading(summary: String?) =
        emitAgentStep("reading", summary ?: "Reading files", finalize = true)

    fun onAgentWriting(text: String?) =
        emitAgentStep("writing", text ?: "Writing files", finalize = false)

    fun onAgentRunning(text: String?) =
        emitAgentStep("running", text ?: "Running command", finalize = false)

    private fun emitAgentStep(kind: String, title: String, finalize: Boolean) {
        // Close previous still-running agent step (legacy events implied "previous done")
        lastAgentStepId?.let { prev -> bus.endStep(turnId, prev, StepStatuses.SUCCESS) }
        val sid = nextStepId(kind)
        bus.startStep(turnId, sid, kind, title, parentStepId = llmStepId)
        if (finalize) {
            bus.endStep(turnId, sid, StepStatuses.SUCCESS)
            lastAgentStepId = null
        } else {
            lastAgentStepId = sid
        }
    }

    fun onPlanUpdate(payload: Any?) {
        val sid = nextStepId("plan")
        bus.startStep(turnId, sid, StepKinds.PLAN, "Plan")
        bus.emit(turnId, sid, EventTypes.PLAN_UPDATE, payload)
        bus.endStep(turnId, sid, StepStatuses.SUCCESS)
    }

    fun onRiskNotice(payload: Any?) =
        bus.emit(turnId, llmStepId ?: turnId, EventTypes.RISK_NOTICE, payload)

    fun onNeedsInput(payload: Any?) =
        bus.emit(turnId, llmStepId ?: turnId, EventTypes.NEEDS_INPUT, payload)

    fun onError(code: Int, message: String) {
        // Surface as a synthetic step.end on the active LLM/tool step (if any),
        // then defer turn-end to the caller which knows the terminal reason.
        val sid = llmStepId ?: turnId
        bus.emit(
            turnId, sid, "error",
            mapOf("code" to code, "message" to message),
        )
    }

    /** Call on every legacy `done` event. Only terminal reasons close the turn. */
    fun onDone(reason: String) {
        val terminal = reason in TERMINAL_REASONS
        if (!terminal) return
        if (ended) return
        ended = true

        // Close any still-open steps
        toolSteps.values.forEach { bus.endStep(turnId, it, StepStatuses.CANCELLED) }
        toolSteps.clear()
        lastAgentStepId?.let { bus.endStep(turnId, it, StepStatuses.SUCCESS) }
        lastAgentStepId = null
        llmStepId?.let { bus.endStep(turnId, it, StepStatuses.SUCCESS) }
        llmStepId = null

        val status =
            when (reason) {
                "failed" -> TurnStatuses.FAILED
                "stopped" -> TurnStatuses.STOPPED
                "max_steps" -> TurnStatuses.MAX_STEPS
                else -> TurnStatuses.FINAL
            }
        bus.endTurn(turnId, status, reason)
    }

    /** Call when SSE stream closes without a terminal done event. */
    fun onAbnormalClose() {
        if (ended) return
        ended = true
        toolSteps.values.forEach { bus.endStep(turnId, it, StepStatuses.CANCELLED) }
        toolSteps.clear()
        lastAgentStepId?.let { bus.endStep(turnId, it, StepStatuses.ERROR, "interrupted") }
        lastAgentStepId = null
        llmStepId?.let { bus.endStep(turnId, it, StepStatuses.ERROR, "interrupted") }
        llmStepId = null
        bus.endTurn(turnId, TurnStatuses.INTERRUPTED, "stream_closed")
    }

    companion object {
        private val TERMINAL_REASONS = setOf("final", "failed", "stopped", "max_steps")
    }
}
