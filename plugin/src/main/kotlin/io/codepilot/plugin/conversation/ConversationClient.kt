package io.codepilot.plugin.conversation

import com.fasterxml.jackson.databind.JsonNode
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import java.util.concurrent.atomic.AtomicReference

/**
 * Wraps the SSE conversation API. The caller provides a [Listener] and receives:
 *   - onDelta for streaming text
 *   - onToolCall / onToolResultAck for tool execution lifecycle
 *   - onNeedsInput / onPermissionResult for permission handling
 *   - onSelfCheck for goal evaluation
 *   - onDone / onError / onClosed for lifecycle
 *
 * The implementation is intentionally thin — it parses the JSON `data` payload and
 * forwards the raw [JsonNode] to the listener, so UI code can decide which fields to render.
 *
 * <p>All events correspond to the new [StreamEvent.Type] emitted by [AgentLoop].
 */
class ConversationClient(
    private val http: HttpClientService = HttpClientService.getInstance(),
) {
    private val source = AtomicReference<EventSource>()

    fun run(
        payload: Map<String, Any?>,
        listener: Listener,
    ): EventSource {
        val request = sseRequest("/v1/conversation/run", payload)
        return open(request, listener)
    }

    fun resume(
        payload: Map<String, Any?>,
        listener: Listener,
    ): EventSource {
        val request = sseRequest("/v1/conversation/resume", payload)
        return open(request, listener)
    }

    fun attachRunStream(
        runId: String,
        afterSeq: Int,
        listener: Listener,
    ): EventSource {
        val settings = CodePilotSettings.getInstance()
        val url =
            (settings.state.backendBaseUrl.trimEnd('/') +
                "/v1/conversation/runs/$runId/stream?afterSeq=$afterSeq")
                .toHttpUrl()
        val builder =
            Request
                .Builder()
                .url(url)
                .get()
                .header("Accept", "text/event-stream")
        if (settings.state.privacyMode) {
            builder.header("X-Privacy-Mode", "true")
        }
        return open(builder.build(), listener)
    }

    fun stop(sessionId: String) {
        cancelActiveStream()
        if (sessionId.isNotBlank()) {
            val req = http.postJson("/v1/conversation/stop", mapOf("sessionId" to sessionId))
            http.client().newCall(req).enqueue(noOpCallback)
        }
    }

    fun cancelActiveStream() {
        source.getAndSet(null)?.cancel()
    }

    fun submitToolResult(payload: Map<String, Any?>) {
        val req = http.postJson("/v1/conversation/tool-result", payload)
        http.client().newCall(req).enqueue(noOpCallback)
    }

    fun submitToolResultSync(sessionId: String, toolCallId: String, result: Any?, ok: Boolean): String {
        val payload = mapOf(
            "sessionId" to sessionId,
            "toolCallId" to toolCallId,
            "ok" to ok,
            "result" to result,
        )
        val req = http.postJson("/v1/conversation/tool-result", payload)
        val response = http.client().newCall(req).execute()
        val body = response.body?.string() ?: ""
        if (!response.isSuccessful) {
            throw RuntimeException("submitToolResult failed: HTTP ${response.code} body=$body for toolCallId=$toolCallId")
        }
        response.close()
        return body
    }

    fun submitToolResult(
        sessionId: String,
        toolCallId: String,
        result: Any?,
        ok: Boolean,
    ) {
        submitToolResult(
            mapOf(
                "sessionId" to sessionId,
                "toolCallId" to toolCallId,
                "ok" to ok,
                "result" to result,
            ),
        )
    }

    fun submitPlanData(
        sessionId: String,
        planJson: String,
        ledgerJson: String,
    ) {
        val req =
            http.postJson(
                "/v1/conversation/plan-data",
                mapOf(
                    "sessionId" to sessionId,
                    "plan" to planJson,
                    "ledger" to ledgerJson,
                ),
            )
        http.client().newCall(req).enqueue(noOpCallback)
    }

    fun run(
        sessionId: String,
        text: String,
        mode: String,
        maxReconnects: Int = 3,
        onEvent: (eventType: String, data: Any?) -> Unit,
    ) {
        val payload =
            mutableMapOf<String, Any?>(
                "sessionId" to sessionId,
                "mode" to mode,
                "input" to text,
                "intent" to "new",
            )
        runWithReconnect(payload, maxReconnects, onEvent)
    }

    private fun runWithReconnect(
        payload: MutableMap<String, Any?>,
        retriesLeft: Int,
        onEvent: (eventType: String, data: Any?) -> Unit,
    ) {
        var cleanDoneReceived = false

        run(
            payload.toMap(),
            object : Listener {
                override fun onDelta(text: String) = onEvent("delta", mapOf("text" to text))
                override fun onToolCall(payload: JsonNode) = onEvent("tool_call", http.mapper.treeToValue(payload, Map::class.java))
                override fun onToolResultAck(payload: JsonNode) = onEvent("tool_result_ack", http.mapper.treeToValue(payload, Map::class.java))
                override fun onSelfCheck(payload: JsonNode) = onEvent("self_check", http.mapper.treeToValue(payload, Map::class.java))
                override fun onNeedsInput(payload: JsonNode) = onEvent("needs_input", http.mapper.treeToValue(payload, Map::class.java))
                override fun onTaskUpdate(payload: JsonNode) = onEvent("user_plan_progress", http.mapper.treeToValue(payload, Map::class.java))
                override fun onMemoryUpdate(payload: JsonNode) = onEvent("memory_update", http.mapper.treeToValue(payload, Map::class.java))
                override fun onSkillInvoked(payload: JsonNode) = onEvent("skill_invoked", http.mapper.treeToValue(payload, Map::class.java))
                override fun onError(code: Int, message: String) = onEvent("error", mapOf("code" to code, "message" to message))
                override fun onDone(reason: String, payload: JsonNode) {
                    cleanDoneReceived = true
                    onEvent("done", mapOf("reason" to reason))
                }
                override fun onClosed() {
                    if (cleanDoneReceived) return
                    if (retriesLeft > 0) {
                        val retryPayload = payload.toMutableMap().apply { put("intent", "continue") }
                        Thread.sleep(1000L * (4 - retriesLeft))
                        runWithReconnect(retryPayload, retriesLeft - 1, onEvent)
                    }
                }
            },
        )
    }

    private fun sseRequest(
        path: String,
        body: Any,
    ): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        @Suppress("UNCHECKED_CAST")
        val fields = body as? Map<String, Any?>
        val mode = fields?.get("mode")?.toString()?.trim()
        val sessionId = fields?.get("sessionId")?.toString()?.trim()
        val payload = http.mapper.writeValueAsBytes(body).toRequestBody("application/json".toMediaType())
        val builder =
            Request
                .Builder()
                .url(url)
                .post(payload)
                .header("Accept", "text/event-stream")
        if (!mode.isNullOrBlank()) {
            builder.header("X-Conversation-Mode", mode)
        }
        if (!sessionId.isNullOrBlank()) {
            builder.header("X-Session-Id", sessionId)
        }
        if (settings.state.privacyMode) {
            builder.header("X-Privacy-Mode", "true")
        }
        if (settings.state.anonymousMode) {
            builder.header("X-Anonymous-Mode", "true")
        }
        return builder.build()
    }

    private fun open(
        request: Request,
        listener: Listener,
    ): EventSource {
        val es = http.openSse(request, EventSourceAdapter(listener, http))
        source.set(es)
        return es
    }

    private val noOpCallback =
        object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {}
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) = response.close()
        }

    interface Listener {
        /** Streaming text delta from LLM output */
        fun onDelta(text: String) {}
        /** Tool call was emitted by the agent */
        fun onToolCall(payload: JsonNode) {}
        /** Tool result acknowledgment (success/failure) */
        fun onToolResultAck(payload: JsonNode) {}
        /** Goal evaluation result */
        fun onSelfCheck(payload: JsonNode) {}
        /** Agent needs user input (ask_user tool) */
        fun onNeedsInput(payload: JsonNode) {}
        /** Task progress update */
        fun onTaskUpdate(payload: JsonNode) {}
        /** Memory update notification */
        fun onMemoryUpdate(payload: JsonNode) {}
        /** Skill was invoked by the agent */
        fun onSkillInvoked(payload: JsonNode) {}
        /** A subagent was spawned */
        fun onSubagentSpawn(payload: JsonNode) {}
        /** A subagent reported progress */
        fun onSubagentProgress(payload: JsonNode) {}
        /** A subagent completed successfully */
        fun onSubagentComplete(payload: JsonNode) {}
        /** A subagent failed */
        fun onSubagentFailed(payload: JsonNode) {}
        /** A fork session was created */
        fun onForkCreated(payload: JsonNode) {}
        /** Error from the backend */
        fun onError(code: Int, message: String) {}
        /** Terminal event with reason */
        fun onDone(reason: String, payload: JsonNode) {}
        /** Stream was abruptly closed */
        fun onClosed() {}
        /** HTTP 429 — rate limited */
        fun onRateLimited(code: Int, message: String, retryAfterSec: Int, opType: String?) {
            onError(code, message)
        }

        // ── Deprecated graph-engine callbacks (no longer emitted by backend,
        // kept for compile compatibility with CefChatPanel/CodePilotChatPanel) ──
        fun onPlan(payload: JsonNode) {}
        fun onPlanDelta(payload: JsonNode) {}
        fun onTaskLedger(payload: JsonNode) {}
        fun onRiskNotice(payload: JsonNode) {}
        fun onGraphPlan(payload: JsonNode) {}
        fun onGraphTransition(payload: JsonNode) {}
        fun onGraphInfoRequest(payload: JsonNode) {}
        fun onGraphInfoResult(payload: JsonNode) {}
        fun onGraphVerify(payload: JsonNode) {}
        fun onGraphRepairPlan(payload: JsonNode) {}
        fun onGraphPhaseDone(payload: JsonNode) {}
        fun onGraphCheckpoint(payload: JsonNode) {}
        fun onGraphBudgetAlert(payload: JsonNode) {}
        fun onSkillsActivated(payload: JsonNode) {}
        fun onUserPlan(payload: JsonNode) {}
        fun onUserPlanProgress(payload: JsonNode) {}
        fun onAgentThinking(payload: JsonNode) {}
        fun onAgentReading(payload: JsonNode) {}
        fun onAgentWriting(payload: JsonNode) {}
        fun onAgentRunning(payload: JsonNode) {}
        fun onRunStarted(payload: JsonNode) {}
        fun onRunReclaimed(payload: JsonNode) {}
        // ── End deprecated ──
    }

    private class EventSourceAdapter(
        private val listener: Listener,
        private val http: HttpClientService,
    ) : EventSourceListener() {
        override fun onOpen(eventSource: EventSource, response: Response) {}

        override fun onEvent(
            eventSource: EventSource,
            id: String?,
            type: String?,
            data: String,
        ) {
            val node: JsonNode = http.mapper.readTree(data.ifEmpty { "{}" })
            when (type) {
                // ── Client-facing event names (renamed by ConversationController.mapSseEventName) ──
                "delta" -> {
                    // text -> delta: streaming LLM text output
                    val text = node.path("content").asText("")
                    if (text.isNotEmpty()) listener.onDelta(text)
                }
                "agent_thinking" -> {
                    // thinking -> agent_thinking: agent reasoning step
                    val text = node.path("content").asText("")
                    if (text.isNotEmpty()) listener.onDelta(text)
                }
                "tool_call" -> {
                    // tool_call_start -> tool_call: agent wants to execute a tool
                    // Normalize field names: backend uses callId/toolName, plugin expects id/name
                    listener.onToolCall(normalizeToolCallFields(node))
                }
                "tool_result_ack" -> {
                    // tool_call_end / permission_result -> tool_result_ack
                    listener.onToolResultAck(normalizeToolResultFields(node))
                }
                "needs_input" -> {
                    // ask_permission -> needs_input: agent needs user approval
                    listener.onNeedsInput(normalizeToolCallFields(node))
                }
                "graph_checkpoint" -> {
                    // checkpoint / checkpoint_writer -> graph_checkpoint
                }
                "graph_budget_alert" -> {
                    // compacted -> graph_budget_alert
                }
                "self_check" -> {
                    // goal_evaluation -> self_check
                    listener.onSelfCheck(node)
                }
                "task_update" -> {
                    listener.onTaskUpdate(node)
                }
                "memory_update" -> {
                    listener.onMemoryUpdate(node)
                }
                "skill_invoked" -> {
                    listener.onSkillInvoked(node)
                }
                "subagent_spawn" -> listener.onSubagentSpawn(node)
                "subagent_progress" -> listener.onSubagentProgress(node)
                "subagent_complete" -> listener.onSubagentComplete(node)
                "subagent_failed" -> listener.onSubagentFailed(node)
                "fork_created" -> listener.onForkCreated(node)
                "agent_switch" -> {} // agent mode switch
                "error" ->
                    listener.onError(node.path("code").asInt(50001), node.path("message").asText(""))
                "done" -> listener.onDone(node.path("reason").asText("final"), node)
                // ── Also accept internal names for durability (replay from EnvelopeStore
                //    stores the internal type before rename) ──
                "text" -> {
                    val text = node.path("content").asText("")
                    if (text.isNotEmpty()) listener.onDelta(text)
                }
                "thinking" -> {
                    val text = node.path("content").asText("")
                    if (text.isNotEmpty()) listener.onDelta(text)
                }
                "tool_call_start" -> listener.onToolCall(normalizeToolCallFields(node))
                "tool_call_end" -> listener.onToolResultAck(normalizeToolResultFields(node))
                "ask_permission" -> listener.onNeedsInput(normalizeToolCallFields(node))
                "permission_result" -> listener.onToolResultAck(normalizeToolResultFields(node))
                "checkpoint" -> {}
                "checkpoint_writer" -> {}
                "compacted" -> {}
                "goal_evaluation" -> listener.onSelfCheck(node)
                else -> {} // ignore unknown events
            }
        }

        override fun onClosed(eventSource: EventSource) {
            listener.onClosed()
        }

        override fun onFailure(
            eventSource: EventSource,
            t: Throwable?,
            response: Response?,
        ) {
            val parsed = response?.let { SseHttpErrors.parse(it, http.mapper) }
            response?.close()
            if (parsed != null && parsed.isRateLimited) {
                listener.onRateLimited(
                    parsed.apiCode,
                    SseHttpErrors.userMessage(parsed),
                    parsed.retryAfterSec,
                    parsed.opType,
                )
                return
            }
            if (parsed != null) {
                listener.onError(parsed.apiCode, parsed.message)
            } else {
                listener.onError(50002, t?.message ?: "stream failed")
            }
            listener.onClosed()
        }

        /**
         * Normalize tool call / permission fields from backend naming to plugin naming.
         * Backend sends: callId, toolName → Plugin expects: id, name
         */
        private fun normalizeToolCallFields(node: JsonNode): JsonNode {
            val obj = http.mapper.createObjectNode()
            // Copy all existing fields
            node.fields().forEach { (key, value) -> obj.set<JsonNode>(key, value) }
            // Add id/name aliases from callId/toolName if not already present
            if (!obj.has("id") && obj.has("callId")) {
                obj.put("id", obj.path("callId").asText())
            }
            if (!obj.has("name") && obj.has("toolName")) {
                obj.put("name", obj.path("toolName").asText())
            }
            // Backend may send args as a JSON string; coerce to object for UI / adapter.
            if (obj.has("args")) {
                val argsNode = obj.path("args")
                if (argsNode.isTextual) {
                    val text = argsNode.asText().trim()
                    if (text.startsWith("{") || text.startsWith("[")) {
                        runCatching { obj.set<JsonNode>("args", http.mapper.readTree(text)) }
                    }
                }
            }
            return obj
        }

        /**
         * Normalize tool result fields from backend naming to plugin naming.
         * Backend sends: callId → Plugin expects: toolCallId or id
         */
        private fun normalizeToolResultFields(node: JsonNode): JsonNode {
            val obj = http.mapper.createObjectNode()
            node.fields().forEach { (key, value) -> obj.set<JsonNode>(key, value) }
            if (!obj.has("toolCallId") && obj.has("callId")) {
                obj.put("toolCallId", obj.path("callId").asText())
            }
            if (!obj.has("id") && obj.has("callId")) {
                obj.put("id", obj.path("callId").asText())
            }
            return obj
        }
    }
}