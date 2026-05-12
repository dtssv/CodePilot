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
 *   - a delta callback for chat-mode tokens / final.answer text
 *   - one-shot callbacks for plan / plan_delta / task_ledger / tool_call / risk_notice / needs_input / self_check
 *   - lifecycle callbacks for done / error / closed
 *
 * The implementation is intentionally thin — it parses the JSON `data` payload and forwards the
 * raw [JsonNode] to the listener, so UI code can decide which fields to render.
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

    fun stop(sessionId: String) {
        source.getAndSet(null)?.cancel()
        val req = http.postJson("/v1/conversation/stop", mapOf("sessionId" to sessionId))
        http.client().newCall(req).enqueue(noOpCallback)
    }

    fun submitToolResult(payload: Map<String, Any?>) {
        val req = http.postJson("/v1/conversation/tool-result", payload)
        http.client().newCall(req).enqueue(noOpCallback)
    }

    /** Convenience overload for submitting a tool result by individual fields. */
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

    /** Submit plan data for display. */
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

    /**
     * Convenience: run a conversation with a simple callback for each SSE event.
     * Supports automatic SSE reconnection with intent=continue on disconnect.
     */
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
        run(
            payload.toMap(),
            object : Listener {
                override fun onDelta(text: String) = onEvent("delta", mapOf("text" to text))

                override fun onToolCall(payload: JsonNode) = onEvent("tool_call", http.mapper.treeToValue(payload, Map::class.java))

                override fun onToolResultAck(payload: JsonNode) =
                    onEvent("tool_result_ack", http.mapper.treeToValue(payload, Map::class.java))

                override fun onPlan(payload: JsonNode) = onEvent("plan", http.mapper.treeToValue(payload, Map::class.java))

                override fun onPlanDelta(payload: JsonNode) = onEvent("plan_delta", http.mapper.treeToValue(payload, Map::class.java))

                override fun onTaskLedger(payload: JsonNode) = onEvent("task_ledger", http.mapper.treeToValue(payload, Map::class.java))

                override fun onRiskNotice(payload: JsonNode) = onEvent("risk_notice", http.mapper.treeToValue(payload, Map::class.java))

                override fun onNeedsInput(payload: JsonNode) = onEvent("needs_input", http.mapper.treeToValue(payload, Map::class.java))

                override fun onDigest(payload: JsonNode) = onEvent("digest", http.mapper.treeToValue(payload, Map::class.java))

                override fun onSelfCheck(payload: JsonNode) = onEvent("self_check", http.mapper.treeToValue(payload, Map::class.java))

                override fun onError(
                    code: Int,
                    message: String,
                ) = onEvent("error", mapOf("code" to code, "message" to message))

                override fun onDone(
                    reason: String,
                    payload: JsonNode,
                ) = onEvent("done", mapOf("reason" to reason))

                override fun onClosed() {
                    // Auto-reconnect: if the stream was dropped unexpectedly (not a clean done),
                    // retry with intent=continue
                    if (retriesLeft > 0) {
                        val retryPayload = payload.toMutableMap().apply { put("intent", "continue") }
                        Thread.sleep(1000L * (4 - retriesLeft)) // exponential-ish backoff
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
        val payload = http.mapper.writeValueAsBytes(body).toRequestBody("application/json".toMediaType())
        val builder =
            Request
                .Builder()
                .url(url)
                .post(payload)
                .header("Accept", "text/event-stream")
        // ★ Privacy Mode header: inform backend to skip telemetry/logging
        if (settings.state.privacyMode) {
            builder.header("X-Privacy-Mode", "true")
        }
        // ★ Anonymous mode header
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
            override fun onFailure(
                call: okhttp3.Call,
                e: java.io.IOException,
            ) {}

            override fun onResponse(
                call: okhttp3.Call,
                response: okhttp3.Response,
            ) = response.close()
        }

    /** Listener interface returned to UI. */
    interface Listener {
        fun onSkillsActivated(payload: JsonNode) {}

        fun onTaskLedger(payload: JsonNode) {}

        fun onPlan(payload: JsonNode) {}

        fun onPlanDelta(payload: JsonNode) {}

        fun onSelfCheck(payload: JsonNode) {}

        fun onRiskNotice(payload: JsonNode) {}

        fun onNeedsInput(payload: JsonNode) {}

        fun onToolCall(payload: JsonNode) {}

        fun onToolResultAck(payload: JsonNode) {}

        fun onDelta(text: String) {}

        fun onDigest(payload: JsonNode) {}

        fun onPatch(payload: JsonNode) {}

        fun onUsage(payload: JsonNode) {}

        fun onError(
            code: Int,
            message: String,
        ) {}

        fun onDone(
            reason: String,
            payload: JsonNode,
        ) {}

        fun onClosed() {}

        // ── Graph engine events ──
        fun onGraphPlan(payload: JsonNode) {}

        fun onGraphTransition(payload: JsonNode) {}

        fun onGraphInfoRequest(payload: JsonNode) {}

        fun onGraphInfoResult(payload: JsonNode) {}

        fun onGraphVerify(payload: JsonNode) {}

        fun onGraphRepairPlan(payload: JsonNode) {}

        fun onGraphPhaseDone(payload: JsonNode) {}

        fun onGraphBudgetAlert(payload: JsonNode) {}

        // ── Dual-layer plan events ──
        fun onUserPlan(payload: JsonNode) {}

        fun onUserPlanProgress(payload: JsonNode) {}
    }

    private class EventSourceAdapter(
        private val listener: Listener,
        private val http: HttpClientService,
    ) : EventSourceListener() {
        override fun onOpen(
            eventSource: EventSource,
            response: Response,
        ) {
            // Do NOT close the response here — the SSE stream needs to remain open
            // for OkHttp's EventSource to read events. The response body is consumed
            // internally by EventSource and closed automatically when the stream ends.
        }

        override fun onEvent(
            eventSource: EventSource,
            id: String?,
            type: String?,
            data: String,
        ) {
            val node: JsonNode = http.mapper.readTree(data.ifEmpty { "{}" })
            when (type) {
                "skills_activated" -> listener.onSkillsActivated(node)
                "task_ledger" -> listener.onTaskLedger(node)
                "plan" -> listener.onPlan(node)
                "plan_delta" -> listener.onPlanDelta(node)
                "self_check" -> listener.onSelfCheck(node)
                "risk_notice" -> listener.onRiskNotice(node)
                "needs_input" -> listener.onNeedsInput(node)
                "tool_call" -> listener.onToolCall(node)
                "tool_result_ack" -> listener.onToolResultAck(node)
                "digest" -> listener.onDigest(node)
                "delta" -> listener.onDelta(node.path("text").asText(""))
                "patch" -> listener.onPatch(node)
                "usage" -> listener.onUsage(node)
                "error" ->
                    listener.onError(node.path("code").asInt(50001), node.path("message").asText(""))
                "done" -> listener.onDone(node.path("reason").asText("final"), node)
                // ── Graph engine events ──
                "graph_plan" -> listener.onGraphPlan(node)
                "graph_transition" -> listener.onGraphTransition(node)
                "graph_info_request" -> listener.onGraphInfoRequest(node)
                "graph_info_result" -> listener.onGraphInfoResult(node)
                "graph_verify" -> listener.onGraphVerify(node)
                "graph_repair_plan" -> listener.onGraphRepairPlan(node)
                "graph_phase_done" -> listener.onGraphPhaseDone(node)
                "graph_budget_alert" -> listener.onGraphBudgetAlert(node)
                "user_plan" -> listener.onUserPlan(node)
                "user_plan_progress" -> listener.onUserPlanProgress(node)
                else -> {} // ignore comments / unknown events
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
            response?.close()
            listener.onError(50002, t?.message ?: "stream failed")
            listener.onClosed()
        }
    }
}
