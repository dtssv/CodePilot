package io.codepilot.intellij.client

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.intellij.openapi.diagnostic.Logger
import io.codepilot.intellij.settings.CodePilotSettings
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources.createFactory
import java.time.Duration
import java.util.concurrent.TimeUnit

/**
 * HTTP + SSE client for communicating with the CodePilot backend.
 *
 * Handles:
 * - POST /v1/conversation/run (SSE stream)
 * - POST /v1/conversation/tool-result
 * - POST /v1/actions/{type} (SSE stream)
 * - POST /v1/rag/index, POST /v1/rag/search
 * - GET /v1/models
 * - POST /v1/models/test
 * - GET /v1/mcp/packages
 */
class CodePilotClient {

    private val log = Logger.getInstance(CodePilotClient::class.java)
    private val mapper = ObjectMapper()
        .registerKotlinModule()
        .registerModule(JavaTimeModule())

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)   // long for SSE
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val sseFactory = createFactory(httpClient)

    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    // ── SSE: Conversation Run ──────────────────────────────────────────

    /**
     * Opens an SSE stream to POST /v1/conversation/run.
     *
     * @param requestBody the conversation request body as a map
     * @param onEvent     callback for each SSE event
     * @param onError     callback on error
     * @param onComplete  callback when stream ends
     * @return EventSource handle (can be closed to cancel)
     */
    fun streamConversation(
        requestBody: Map<String, Any?>,
        onEvent: (SseEvent) -> Unit,
        onError: (Throwable) -> Unit,
        onComplete: () -> Unit
    ): EventSource {
        val json = mapper.writeValueAsString(requestBody)
        val request = buildPostRequest("/v1/conversation/run", json)

        return sseFactory.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (data.isBlank() || data == "[DONE]") {
                    onComplete()
                    return
                }
                try {
                    val sseEvent = parseSseEvent(data)
                    onEvent(sseEvent)
                } catch (e: Exception) {
                    log.warn("Failed to parse SSE event: $data", e)
                }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val msg = "SSE connection failed: ${response?.code} ${response?.body?.string()}"
                log.error(msg, t)
                onError(t ?: RuntimeException(msg))
            }

            override fun onClosed(eventSource: EventSource) {
                onComplete()
            }
        })
    }

    // ── SSE: Action ────────────────────────────────────────────────────

    /**
     * Opens an SSE stream to POST /v1/actions/{actionType}.
     */
    fun streamAction(
        actionType: String,
        requestBody: Map<String, Any?>,
        onEvent: (SseEvent) -> Unit,
        onError: (Throwable) -> Unit,
        onComplete: () -> Unit
    ): EventSource {
        val json = mapper.writeValueAsString(requestBody)
        val request = buildPostRequest("/v1/actions/$actionType", json)

        return sseFactory.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (data.isBlank() || data == "[DONE]") {
                    onComplete()
                    return
                }
                try {
                    val sseEvent = parseSseEvent(data)
                    onEvent(sseEvent)
                } catch (e: Exception) {
                    log.warn("Failed to parse action SSE event: $data", e)
                }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                onError(t ?: RuntimeException("SSE connection failed: ${response?.code}"))
            }

            override fun onClosed(eventSource: EventSource) {
                onComplete()
            }
        })
    }

    // ── REST: Tool Result ──────────────────────────────────────────────

    /**
     * POST /v1/conversation/tool-result
     */
    fun sendToolResult(toolCallId: String, ok: Boolean, result: String, durationMs: Long) {
        val body = mapOf(
            "toolCallId" to toolCallId,
            "ok" to ok,
            "result" to result,
            "durationMs" to durationMs
        )
        postJson("/v1/conversation/tool-result", body)
    }

    // ── REST: Models ───────────────────────────────────────────────────

    /**
     * GET /v1/models
     */
    fun listModels(): Map<String, Any>? {
        return getJson("/v1/models")
    }

    /**
     * POST /v1/models/test
     */
    fun testModel(request: Map<String, Any?>): Map<String, Any>? {
        return postJson("/v1/models/test", request)
    }

    // ── REST: RAG ──────────────────────────────────────────────────────

    /**
     * POST /v1/rag/index
     */
    fun indexRag(request: Map<String, Any?>): Int? {
        val json = mapper.writeValueAsString(request)
        val requestObj = buildPostRequest("/v1/rag/index", json)
        httpClient.newCall(requestObj).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("RAG index failed: ${response.code}")
                return null
            }
            return response.body?.string()?.toIntOrNull()
        }
    }

    /**
     * POST /v1/rag/search
     */
    fun searchRag(request: Map<String, Any?>): Map<String, Any>? {
        return postJson("/v1/rag/search", request)
    }

    // ── REST: MCP Hub ──────────────────────────────────────────────────

    /**
     * GET /v1/mcp/packages?q=...
     */
    fun searchPackages(query: String? = null): List<Map<String, Any>>? {
        val path = if (query != null) "/v1/mcp/packages?q=$query" else "/v1/mcp/packages"
        val result = getJson(path) ?: return null
        @Suppress("UNCHECKED_CAST")
        return result["packages"] as? List<Map<String, Any>>
    }

    /**
     * POST /v1/mcp/packages/install
     */
    fun installPackage(request: Map<String, Any?>): Map<String, Any>? {
        return postJson("/v1/mcp/packages/install", request)
    }

    // ── REST: Auth ─────────────────────────────────────────────────────

    /**
     * POST /v1/auth/login
     */
    fun login(request: Map<String, Any?>): Map<String, Any>? {
        return postJson("/v1/auth/login", request)
    }

    // ── Internal Helpers ───────────────────────────────────────────────

    private fun buildPostRequest(path: String, jsonBody: String): Request {
        val settings = CodePilotSettings.getInstance()
        return Request.Builder()
            .url("${settings.serverUrl}$path")
            .addHeader("Authorization", "Bearer ${settings.jwtToken}")
            .addHeader("X-CodePilot-User-Id", settings.deviceId)
            .addHeader("Content-Type", "application/json")
            .addHeader("Accept", "text/event-stream")
            .post(jsonBody.toRequestBody(JSON_MEDIA_TYPE))
            .build()
    }

    private fun buildGetRequest(path: String): Request {
        val settings = CodePilotSettings.getInstance()
        return Request.Builder()
            .url("${settings.serverUrl}$path")
            .addHeader("Authorization", "Bearer ${settings.jwtToken}")
            .addHeader("X-CodePilot-User-Id", settings.deviceId)
            .addHeader("Accept", "application/json")
            .get()
            .build()
    }

    private fun getJson(path: String): Map<String, Any>? {
        val request = buildGetRequest(path)
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("GET $path failed: ${response.code}")
                return null
            }
            val body = response.body?.string() ?: return null
            @Suppress("UNCHECKED_CAST")
            return mapper.readValue(body, Map::class.java) as Map<String, Any>
        }
    }

    private fun postJson(path: String, body: Map<String, Any?>): Map<String, Any>? {
        val json = mapper.writeValueAsString(body)
        val request = buildPostRequest(path, json)
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                log.warn("POST $path failed: ${response.code}")
                return null
            }
            val responseBody = response.body?.string() ?: return null
            @Suppress("UNCHECKED_CAST")
            return mapper.readValue(responseBody, Map::class.java) as Map<String, Any>
        }
    }

    private fun parseSseEvent(data: String): SseEvent {
        // The backend sends AgentEvent as JSON with a "type" discriminator
        @Suppress("UNCHECKED_CAST")
        val map = mapper.readValue(data, Map::class.java) as Map<String, Any>
        val type = map["type"] as? String ?: throw IllegalArgumentException("Missing type field")

        return when (type) {
            "delta" -> {
                val text = (map["text"] as? String) ?: ""
                SseEvent.Delta(text)
            }
            "plan" -> SseEvent.Plan(map["steps"])
            "planDelta" -> SseEvent.PlanDelta(map["delta"])
            "digest" -> SseEvent.Digest(map["summary"] as? String)
            "taskLedger" -> {
                @Suppress("UNCHECKED_CAST")
                SseEvent.TaskLedger(
                    map["goal"] as? String,
                    map["subtasks"] as? List<Any>
                )
            }
            "toolCall" -> {
                @Suppress("UNCHECKED_CAST")
                SseEvent.ToolCall(
                    id = map["id"] as? String ?: "",
                    name = map["name"] as? String ?: "",
                    args = map["args"] as? Map<String, Any>,
                    riskLevel = map["riskLevel"] as? String,
                    why = map["why"] as? String
                )
            }
            "toolResultAck" -> SseEvent.ToolResultAck(
                toolCallId = map["toolCallId"] as? String ?: "",
                status = map["status"] as? String ?: ""
            )
            "patch" -> {
                @Suppress("UNCHECKED_CAST")
                val patchesList = map["patches"] as? List<Map<String, Any>> ?: emptyList()
                val patches = patchesList.map { p ->
                    @Suppress("UNCHECKED_CAST")
                    PatchOp(
                        path = p["path"] as? String ?: "",
                        type = p["type"] as? String ?: "REPLACE",
                        search = p["search"] as? String,
                        replace = p["replace"] as? String,
                        range = (p["range"] as? Map<String, Any>)?.let { r ->
                            RangeSpec(
                                startLine = (r["startLine"] as? Number)?.toInt() ?: 0,
                                endLine = (r["endLine"] as? Number)?.toInt() ?: 0
                            )
                        },
                        description = p["description"] as? String
                    )
                }
                SseEvent.Patch(patches)
            }
            "usage" -> SseEvent.Usage(
                inputTokens = (map["inputTokens"] as? Number)?.toLong() ?: 0,
                outputTokens = (map["outputTokens"] as? Number)?.toLong() ?: 0
            )
            "error" -> SseEvent.Error(
                code = (map["code"] as? Number)?.toInt() ?: -1,
                message = map["message"] as? String
            )
            "done" -> SseEvent.Done(
                reason = map["reason"] as? String,
                continuationToken = map["continuationToken"] as? String,
                summary = map["summary"] as? String,
                nextAction = map["nextAction"] as? String
            )
            else -> throw IllegalArgumentException("Unknown SSE event type: $type")
        }
    }
}