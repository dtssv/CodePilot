package io.codepilot.plugin.conversation

import com.fasterxml.jackson.databind.JsonNode
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.HttpUrl.Companion.toHttpUrl
import io.codepilot.plugin.settings.CodePilotSettings
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

    fun run(payload: Map<String, Any?>, listener: Listener): EventSource {
        val request = sseRequest("/v1/conversation/run", payload)
        return open(request, listener)
    }

    fun resume(payload: Map<String, Any?>, listener: Listener): EventSource {
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

    private fun sseRequest(path: String, body: Any): Request {
        val settings = CodePilotSettings.getInstance()
        val url = (settings.state.backendBaseUrl.trimEnd('/') + path).toHttpUrl()
        val payload = http.mapper.writeValueAsBytes(body).toRequestBody("application/json".toMediaType())
        return Request.Builder().url(url).post(payload).header("Accept", "text/event-stream").build()
    }

    private fun open(request: Request, listener: Listener): EventSource {
        val es = http.openSse(request, EventSourceAdapter(listener, http))
        source.set(es)
        return es
    }

    private val noOpCallback =
        object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {}
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) = response.close()
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
        fun onError(code: Int, message: String) {}
        fun onDone(reason: String, payload: JsonNode) {}
        fun onClosed() {}
    }

    private class EventSourceAdapter(
        private val listener: Listener,
        private val http: HttpClientService,
    ) : EventSourceListener() {

        override fun onOpen(eventSource: EventSource, response: Response) {
            response.close()
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
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
                else -> {} // ignore comments / unknown events
            }
        }

        override fun onClosed(eventSource: EventSource) {
            listener.onClosed()
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            response?.close()
            listener.onError(50002, t?.message ?: "stream failed")
            listener.onClosed()
        }
    }
}