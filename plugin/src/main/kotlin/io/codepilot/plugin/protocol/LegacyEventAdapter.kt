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

    /** Kind of the last open agent step (suppress duplicate running heartbeats). */
    private var lastAgentKind: String? = null

    /** Stable plan step for the turn (user_plan + progress). */
    private var planStepId: String? = null

    /** Monotonic counter for step IDs within this turn. */
    private var stepCounter = 0

    /** Whether endTurn() has already been emitted (idempotency). */
    private var ended = false

    /** Single writing step per turn — merged file list from all apply phases. */
    private var writingStepId: String? = null

    private val writingFilesAcc = mutableListOf<Map<String, Any?>>()

    private fun nextStepId(prefix: String): String {
        stepCounter += 1
        return "$turnId-$prefix-$stepCounter"
    }

    fun onTurnStart(
        userMessage: String,
        contextRefs: List<Map<String, Any?>>,
        images: List<Map<String, Any?>> = emptyList(),
        forkMessageIndex: Int? = null,
    ) {
        writingStepId = null
        writingFilesAcc.clear()
        bus.startTurn(turnId, userMessage, contextRefs, images, forkMessageIndex)
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
        // Close the open LLM segment so this tool appears *after* prior output in the timeline.
        // The next text delta will open a fresh LLM step below the tool card.
        llmStepId?.let { prev ->
            bus.endStep(turnId, prev, StepStatuses.SUCCESS)
            llmStepId = null
        }
        // Use backend toolCallId as envelope stepId so shell.ask aligns with the tool card.
        val sid = toolCallId
        toolSteps[toolCallId] = sid
        toolCallInfos[toolCallId] = ToolCallInfo(toolName, args)
        val title =
            when (toolName) {
                "shell.exec", "shell.session" ->
                    args?.path("command")?.asText(null)?.trim()?.takeIf { it.isNotBlank() }
                        ?: toolName
                else -> toolName
            }
        val detail =
            if (toolName == "shell.exec" || toolName == "shell.session") {
                val cmd = args?.path("command")?.asText(null)?.trim().orEmpty()
                mapOf("kind" to "shell", "command" to cmd, "status" to "running")
            } else {
                null
            }
        bus.startStep(turnId, sid, StepKinds.TOOL, title, parentStepId = llmStepId, detail = detail)
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

    fun onAgentWriting(text: String?, files: List<Map<String, Any?>>? = null) {
        if (!files.isNullOrEmpty()) {
            for (f in files) {
                val path = f["path"]?.toString()?.trim().orEmpty()
                if (path.isEmpty()) continue
                writingFilesAcc.removeAll { it["path"]?.toString() == path }
                writingFilesAcc.add(f)
            }
        }
        val summary = text?.takeIf { it.isNotBlank() }
            ?: if (writingFilesAcc.isEmpty()) "Writing files"
            else writingFilesAcc.joinToString(", ") { f ->
                val path = f["path"]?.toString() ?: "?"
                val op = f["op"]?.toString() ?: "write"
                val lines = f["lineCount"]
                val label = if (op == "create") "新建" else if (op == "delete") "删除" else "修改"
                if (lines != null) "$label: $path +${lines}行" else "$label: $path"
            }
        val existing = writingStepId
        if (existing != null) {
            bus.stepProgress(
                turnId,
                existing,
                mapOf(
                    "files" to writingFilesAcc.toList(),
                    "text" to summary,
                    "kind" to "writing",
                ),
            )
            return
        }
        lastAgentStepId?.let { prev -> bus.endStep(turnId, prev, StepStatuses.SUCCESS) }
        val sid = nextStepId("writing")
        writingStepId = sid
        lastAgentStepId = sid
        lastAgentKind = "writing"
        bus.startStep(
            turnId,
            sid,
            "writing",
            summary,
            parentStepId = llmStepId,
            detail = if (writingFilesAcc.isEmpty()) null else mapOf("files" to writingFilesAcc.toList()),
        )
    }

    fun onAgentRunning(text: String?) =
        emitAgentStep("running", text ?: "Running command", finalize = false)

    private fun emitAgentStep(
        kind: String,
        title: String,
        finalize: Boolean,
        detail: Map<String, Any?>? = null,
    ) {
        if (!finalize && lastAgentStepId != null && lastAgentKind == kind) {
            return
        }
        lastAgentStepId?.let { prev -> bus.endStep(turnId, prev, StepStatuses.SUCCESS) }
        val sid = nextStepId(kind)
        bus.startStep(turnId, sid, kind, title, parentStepId = llmStepId, detail = detail)
        if (finalize) {
            bus.endStep(turnId, sid, StepStatuses.SUCCESS)
            lastAgentStepId = null
            lastAgentKind = null
        } else {
            lastAgentStepId = sid
            lastAgentKind = kind
        }
    }

    /** Graph node transition — show as a running progress step in the chat timeline. */
    fun onGraphTransition(payload: Any?) {
        val message =
            (payload as? Map<*, *>)?.get("message")?.toString()
                ?: (payload as? com.fasterxml.jackson.databind.JsonNode)?.path("message")?.asText(null)
        if (message.isNullOrBlank()) return
        emitAgentStep("running", message, finalize = false)
    }

    fun onPlanUpdate(payload: Any?) {
        val sid =
            planStepId ?: run {
                val s = nextStepId("plan")
                bus.startStep(turnId, s, StepKinds.PLAN, "执行计划")
                planStepId = s
                s
            }
        bus.emit(turnId, sid, EventTypes.PLAN_UPDATE, payload)
    }

    fun onPlanProgress(payload: Any?) {
        val sid = planStepId ?: return
        bus.emit(turnId, sid, EventTypes.PLAN_PROGRESS, payload)
    }

    fun onGraphVerify(payload: Any?) {
        val map =
            when (payload) {
                is Map<*, *> -> payload
                is com.fasterxml.jackson.databind.JsonNode -> payload
                else -> null
            }
        val result =
            when (map) {
                is Map<*, *> -> map["result"]?.toString()
                is com.fasterxml.jackson.databind.JsonNode -> map.path("result").asText(null)
                else -> null
            } ?: "uncertain"
        val summary =
            when (map) {
                is Map<*, *> -> map["summary"]?.toString()
                is com.fasterxml.jackson.databind.JsonNode -> map.path("summary").asText(null)
                else -> null
            }
        val title =
            when (result) {
                "success" -> "验证通过"
                "fail" -> "验证未通过"
                else -> "验证结果待确认"
            }
        val failures =
            when (map) {
                is Map<*, *> ->
                    (map["failures"] as? List<*>)?.mapNotNull { it?.toString()?.takeIf { s -> s.isNotBlank() } }
                        ?: emptyList()
                is com.fasterxml.jackson.databind.JsonNode -> {
                    val node = map.path("failures")
                    if (!node.isArray) emptyList()
                    else node.mapNotNull { it.asText(null)?.takeIf { s -> s.isNotBlank() } }
                }
                else -> emptyList()
            }
        val detail =
            when {
                failures.isNotEmpty() ->
                    mapOf(
                        "output" to failures.joinToString("\n"),
                        "summary" to (summary ?: title),
                    )
                summary != null -> mapOf("summary" to summary)
                else -> null
            }
        val endStatus =
            when (result) {
                "fail" -> StepStatuses.ERROR
                else -> StepStatuses.SUCCESS
            }
        lastAgentStepId?.let { prev -> bus.endStep(turnId, prev, StepStatuses.SUCCESS) }
        val sid = nextStepId("verify")
        bus.startStep(turnId, sid, StepKinds.VERIFY, title, parentStepId = llmStepId, detail = detail)
        bus.endStep(turnId, sid, endStatus, if (result == "fail") summary else null)
        lastAgentStepId = null
        lastAgentKind = null
    }

    fun onGraphPhaseDone(payload: Any?) {
        val phase = (payload as? Map<*, *>)?.get("phase")?.toString()
            ?: (payload as? com.fasterxml.jackson.databind.JsonNode)?.path("phase")?.asText("phase")
            ?: "phase"
        emitAgentStep(StepKinds.SUBTASK, "阶段完成: $phase", finalize = true)
    }

    fun onGraphRepairPlan(payload: Any?) {
        val title = (payload as? Map<*, *>)?.get("summary")?.toString()
            ?: (payload as? com.fasterxml.jackson.databind.JsonNode)?.path("summary")?.asText("修复计划")
            ?: "修复计划"
        emitAgentStep(StepKinds.REPAIR, title, finalize = false)
    }

    fun onGraphBudgetAlert(payload: Any?) {
        val msg = (payload as? Map<*, *>)?.get("message")?.toString()
            ?: (payload as? com.fasterxml.jackson.databind.JsonNode)?.path("message")?.asText("预算警告")
            ?: "预算警告"
        bus.emit(turnId, llmStepId ?: turnId, EventTypes.RISK_NOTICE, mapOf("level" to "warn", "message" to msg))
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
        val terminal = TerminalDoneReasons.isTerminal(reason)
        if (!terminal) return
        if (ended) return
        ended = true

        // Close any still-open steps
        toolSteps.values.forEach { bus.endStep(turnId, it, StepStatuses.CANCELLED) }
        toolSteps.clear()
        lastAgentStepId?.let { bus.endStep(turnId, it, StepStatuses.SUCCESS) }
        lastAgentStepId = null
        planStepId?.let { bus.endStep(turnId, it, StepStatuses.SUCCESS) }
        planStepId = null
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
        planStepId?.let { bus.endStep(turnId, it, StepStatuses.ERROR, "interrupted") }
        planStepId = null
        llmStepId?.let { bus.endStep(turnId, it, StepStatuses.ERROR, "interrupted") }
        llmStepId = null
        bus.endTurn(turnId, TurnStatuses.INTERRUPTED, "stream_closed")
    }

}
