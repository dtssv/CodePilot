package io.codepilot.plugin.protocol

import com.intellij.openapi.diagnostic.Logger
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper

/**
 * Converts events from the conversation backend into bus events for the UI.
 *
 * Supports both old graph-engine observer pattern (CefChatPanel) and
 * new v2 protocol events (via [StreamEvent.Type] from AgentLoop).
 */
class LegacyEventAdapter(
    private val bus: EventBus,
    val turnId: String,
) {
    private val log = Logger.getInstance(LegacyEventAdapter::class.java)
    private val mapper = ObjectMapper()
    private var llmStepId: String? = null
    private var stepCounter = 0
    private var ended = false
    /** toolCallId → (toolName, parsed args node) for result classification */
    private val pendingToolMeta = mutableMapOf<String, Pair<String, JsonNode?>>()

    private fun nextStepId(prefix: String): String {
        stepCounter += 1
        return "$turnId-$prefix-$stepCounter"
    }

    // ── Text delta ──
    fun onTextDelta(text: String) {
        if (text.isEmpty()) return
        val sid = llmStepId ?: run {
            val s = nextStepId("llm")
            bus.startStep(turnId, s, "llm", "Reasoning")
            llmStepId = s
            s
        }
        bus.textDelta(turnId, sid, text)
    }

    // ── Tool call lifecycle ──
    fun onToolCall(toolCallId: String, toolName: String, args: JsonNode?) {
        llmStepId?.let { prev ->
            bus.endStep(turnId, prev, "success")
            llmStepId = null
        }
        val sid = toolCallId
        val (argsNode, argsPayload) = coerceArgs(args)
        pendingToolMeta[toolCallId] = toolName to argsNode
        val title = toolStepTitle(toolName, argsNode, argsPayload)
        bus.startStep(turnId, sid, "tool", title)
        bus.toolCall(turnId, sid, toolName, argsPayload, parentStepId = null)
    }

    // ── Tool result acknowledgment ──
    fun onToolResultAck(toolCallId: String, ok: Boolean, result: String?, error: String?) {
        emitToolResult(toolCallId, ok, result, error, null)
    }

    // 5-arg overload used in CefChatPanel (ToolDispatcher callback: errorCode=String, errorMessage=String)
    fun onToolResultAck(toolCallId: String, ok: Boolean, result: Any?, errorMessage: String?, errorCode: String?) {
        emitToolResult(toolCallId, ok, result, errorMessage, errorCode)
    }

    // 3-arg overload used in CefChatPanel
    fun onToolResultAck(toolCallId: String, ok: Boolean, result: Any?) {
        emitToolResult(toolCallId, ok, result, null, null)
    }

    private fun emitToolResult(
        toolCallId: String,
        ok: Boolean,
        result: Any?,
        errorMessage: String?,
        errorCode: String?,
    ) {
        val sid = toolCallId
        val (toolName, argsNode) = pendingToolMeta.remove(toolCallId) ?: ("" to null)
        val classified = classifyForUi(toolName, argsNode, ok, result, errorCode, errorMessage)
        bus.toolResult(turnId, sid, ok, classified, errorMessage)
        bus.endStep(turnId, sid, if (ok) "success" else "error", errorMessage)
    }

    private fun coerceArgs(args: JsonNode?): Pair<JsonNode?, Map<String, Any?>> {
        if (args == null || args.isNull || args.isMissingNode) {
            return null to emptyMap()
        }
        if (args.isObject) {
            @Suppress("UNCHECKED_CAST")
            return args to (mapper.convertValue(args, Map::class.java) as Map<String, Any?>)
        }
        if (args.isTextual) {
            val text = args.asText().trim()
            if (text.startsWith("{") || text.startsWith("[")) {
                return runCatching {
                    val parsed = mapper.readTree(text)
                    if (parsed.isObject) {
                        @Suppress("UNCHECKED_CAST")
                        parsed to (mapper.convertValue(parsed, Map::class.java) as Map<String, Any?>)
                    } else {
                        null to emptyMap()
                    }
                }.getOrElse { null to emptyMap() }
            }
        }
        return args to emptyMap()
    }

    private fun toolStepTitle(toolName: String, argsNode: JsonNode?, argsMap: Map<String, Any?>): String {
        fun path(): String =
            (argsMap["path"] as? String)?.trim().orEmpty()
                .ifBlank { argsNode?.path("path")?.asText("")?.trim().orEmpty() }
        fun command(): String =
            (argsMap["command"] as? String)?.trim().orEmpty()
                .ifBlank { argsNode?.path("command")?.asText("")?.trim().orEmpty() }
        return when {
            toolName == "shell.exec" || toolName == "shell.session" ->
                command().ifBlank { toolName }
            toolName.startsWith("fs.") || toolName.startsWith("ide.") || toolName.startsWith("code.") ->
                path().ifBlank { toolName }
            else -> toolName
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun classifyForUi(
        toolName: String,
        argsNode: JsonNode?,
        ok: Boolean,
        result: Any?,
        errorCode: String?,
        errorMessage: String?,
    ): Any? {
        when (result) {
            is Map<*, *> ->
                return ToolResultClassifier.classify(
                    toolName, argsNode, ok, result as Map<String, Any?>, errorCode, errorMessage,
                )
            is JsonNode -> {
                if (result.isObject) {
                    val m = mapper.convertValue(result, Map::class.java) as Map<String, Any?>
                    return ToolResultClassifier.classify(toolName, argsNode, ok, m, errorCode, errorMessage)
                }
                if (result.isTextual) {
                    return classifyForUi(toolName, argsNode, ok, result.asText(), errorCode, errorMessage)
                }
            }
            is String -> {
                val text = result.trim()
                if (text.startsWith("{")) {
                    return runCatching {
                        val m = mapper.readValue(text, Map::class.java) as Map<String, Any?>
                        ToolResultClassifier.classify(toolName, argsNode, ok, m, errorCode, errorMessage)
                    }.getOrDefault(result)
                }
            }
        }
        return result
    }

    // ── Needs input / Ask permission ──
    fun onNeedsInput(payload: JsonNode) {
        bus.emit(turnId, llmStepId ?: turnId, "needs_input", payload)
    }

    fun onNeedsInput(data: Any) {
        bus.emit(turnId, llmStepId ?: turnId, "needs_input", data)
    }

    // ── Self check / goal evaluation ──
    fun onSelfCheck(payload: JsonNode) {
        val satisfied = payload.path("satisfied").asBoolean(false)
        val confidence = payload.path("confidence").asDouble()
        val reason = payload.path("reason").asText("")
        val message = "confidence=$confidence reason=$reason"
        if (!satisfied) {
            bus.emit(turnId, llmStepId ?: turnId, "error", mapOf("message" to message))
        } else {
            bus.emit(turnId, llmStepId ?: turnId, "self_check", payload)
        }
    }

    // ── Done ──
    fun onDone(reason: String) {
        if (ended) return
        ended = true
        llmStepId?.let { bus.endStep(turnId, it, "success") }
        bus.endTurn(turnId, reason)
    }

    // ── Turn lifecycle ──
    fun onTurnStart(
        userMessage: String,
        contextRefs: List<Map<String, Any?>>,
        images: List<Map<String, Any?>>,
        forkMessageIndex: Int,
    ) {
        bus.startTurn(turnId, userMessage, contextRefs, images, forkMessageIndex)
    }

    // ── Graph-engine events (deprecated but kept for compile compatibility) ──
    fun onGraphTransition(data: Any) {
        bus.emit(turnId, turnId, "graph_transition", data)
    }

    fun onGraphVerify(data: Any) {
        bus.emit(turnId, turnId, "graph_verify", data)
    }

    fun onGraphRepairPlan(data: Any) {
        bus.emit(turnId, turnId, "graph_repair_plan", data)
    }

    fun onGraphPhaseDone(data: Any) {
        bus.emit(turnId, turnId, "graph_phase_done", data)
    }

    fun onGraphBudgetAlert(data: Any) {
        bus.emit(turnId, turnId, "graph_budget_alert", data)
    }

    fun onGraphBudgetAlert(payload: JsonNode) {
        bus.emit(turnId, turnId, "graph_budget_alert", mapper.convertValue(payload, Map::class.java))
    }

    // ── Plan callbacks ──
    fun onPlanUpdate(data: Any) {
        bus.emit(turnId, turnId, "plan_update", data)
    }

    fun onPlanProgress(data: Any) {
        bus.emit(turnId, turnId, "plan_progress", data)
    }

    // ── Memory update callback ──
    fun onMemoryUpdate(type: String, content: String) {
        bus.emit(turnId, turnId, "memory_update", mapOf("type" to type, "content" to content))
    }

    fun onMemoryUpdate(payload: JsonNode) {
        bus.emit(turnId, turnId, "memory_update", mapper.convertValue(payload, Map::class.java))
    }

    // ── Skill invoked callback ──
    fun onSkillInvoked(skillName: String, description: String) {
        bus.emit(turnId, turnId, "skill_invoked", mapOf("skillName" to skillName, "description" to description))
    }

    fun onSkillInvoked(payload: JsonNode) {
        bus.emit(turnId, turnId, "skill_invoked", mapper.convertValue(payload, Map::class.java))
    }

    // ── Subagent lifecycle callbacks ──
    fun onSubagentSpawn(taskId: String, agentName: String, description: String) {
        bus.emit(turnId, turnId, "subagent_spawn", mapOf("taskId" to taskId, "agentName" to agentName, "description" to description))
    }

    fun onSubagentSpawn(payload: JsonNode) {
        bus.emit(turnId, turnId, "subagent_spawn", mapper.convertValue(payload, Map::class.java))
    }

    fun onSubagentProgress(taskId: String, status: String, progress: String) {
        bus.emit(turnId, turnId, "subagent_progress", mapOf("taskId" to taskId, "status" to status, "progress" to progress))
    }

    fun onSubagentProgress(payload: JsonNode) {
        bus.emit(turnId, turnId, "subagent_progress", mapper.convertValue(payload, Map::class.java))
    }

    fun onSubagentComplete(taskId: String, result: String) {
        bus.emit(turnId, turnId, "subagent_complete", mapOf("taskId" to taskId, "result" to result))
    }

    fun onSubagentComplete(payload: JsonNode) {
        bus.emit(turnId, turnId, "subagent_complete", mapper.convertValue(payload, Map::class.java))
    }

    fun onSubagentFailed(taskId: String, error: String) {
        bus.emit(turnId, turnId, "subagent_failed", mapOf("taskId" to taskId, "error" to error))
    }

    fun onSubagentFailed(payload: JsonNode) {
        bus.emit(turnId, turnId, "subagent_failed", mapper.convertValue(payload, Map::class.java))
    }

    // ── Fork created callback ──
    fun onForkCreated(newSessionId: String, parentSessionId: String) {
        bus.emit(turnId, turnId, "fork_created", mapOf("newSessionId" to newSessionId, "parentSessionId" to parentSessionId))
    }

    fun onForkCreated(payload: JsonNode) {
        bus.emit(turnId, turnId, "fork_created", mapper.convertValue(payload, Map::class.java))
    }

    // ── Agent action callbacks ──
    fun onAgentThinking(summary: String?) {
        bus.emit(turnId, turnId, "agent_thinking", mapOf("summary" to summary))
    }

    fun onAgentReading(summary: String?) {
        bus.emit(turnId, turnId, "agent_reading", mapOf("summary" to summary))
    }

    fun onAgentWriting(text: String?, files: List<Any?>?) {
        val data = if (text != null) mapOf("text" to text, "files" to files) else mapOf("files" to (files ?: emptyList<Any?>()))
        bus.emit(turnId, turnId, "agent_writing", data)
    }

    fun onAgentWriting(payload: JsonNode) {
        bus.emit(turnId, turnId, "agent_writing", mapper.convertValue(payload, Map::class.java))
    }

    fun onAgentRunning(summary: String?) {
        bus.emit(turnId, turnId, "agent_running", mapOf("summary" to summary))
    }

    fun onAgentRunning(payload: JsonNode) {
        bus.emit(turnId, turnId, "agent_running", mapper.convertValue(payload, Map::class.java))
    }

    // ── Other callbacks ──
    fun onRiskNotice(data: Any) {
        bus.emit(turnId, turnId, "risk_notice", data)
    }

    fun onError(code: Int, message: String) {
        bus.emit(turnId, turnId, "error", mapOf("code" to code, "message" to message))
    }

    fun onRunReclaimed(payload: JsonNode) {
        bus.emit(turnId, turnId, "run_reclaimed", payload)
    }

    fun onRunReclaimed(data: String?) {
        bus.emit(turnId, turnId, "run_reclaimed", mapOf("message" to data))
    }

    fun onSkillsActivated(payload: JsonNode) {
        bus.emit(turnId, turnId, "skills_activated", payload)
    }

    // ── Abnormal close ──
    fun onAbnormalClose() {
        if (ended) return
        ended = true
        llmStepId?.let { bus.endStep(turnId, it, "error", "interrupted") }
        bus.endTurn(turnId, "interrupted")
    }
}