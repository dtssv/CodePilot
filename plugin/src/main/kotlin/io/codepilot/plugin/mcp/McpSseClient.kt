package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.diagnostic.Logger
import io.codepilot.plugin.marketplace.LocalMarketplaceStore
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * MCP client for SSE and Streamable HTTP transport modes.
 *
 * SSE mode:
 * - Connects to the server's SSE endpoint for server-to-client messages
 * - Sends client-to-server messages via HTTP POST to a separate endpoint
 *
 * Streamable HTTP mode:
 * - Sends JSON-RPC requests via HTTP POST
 * - Receives responses in the HTTP response body (or via SSE for notifications)
 */
class McpSseClient(
    private val serverId: String,
    private val url: String,
    private val transport: LocalMarketplaceStore.McpTransport,
    private val headers: Map<String, String> = emptyMap(),
) {
    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val seq = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonNode>>()
    private var eventSource: EventSource? = null
    private var messageEndpoint: String? = null

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MINUTES) // SSE streams are long-lived
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }

    private val sseFactory by lazy { EventSources.createFactory(client) }

    val isConnected: Boolean
        get() = when (transport) {
            LocalMarketplaceStore.McpTransport.SSE -> eventSource != null
            LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP -> true // Stateless; always "connected"
            else -> false
        }

    /** Connect to the MCP server. For SSE, opens the SSE stream. */
    fun connect() {
        if (transport == LocalMarketplaceStore.McpTransport.SSE) {
            connectSse()
        }
        // Streamable HTTP is stateless; no persistent connection needed
    }

    /** Disconnect from the MCP server. */
    fun disconnect() {
        eventSource?.cancel()
        eventSource = null
        messageEndpoint = null
        pending.clear()
    }

    /**
     * Send a JSON-RPC call and return the result.
     *
     * For SSE: POST to the message endpoint and wait for response via SSE stream.
     * For Streamable HTTP: POST and read the response directly.
     */
    fun call(method: String, params: Any?): JsonNode {
        val id = seq.getAndIncrement()
        val request: ObjectNode = mapper.createObjectNode()
            .put("jsonrpc", "2.0")
            .put("id", id)
            .put("method", method)
        if (params != null) request.set<ObjectNode>("params", mapper.valueToTree(params))

        return when (transport) {
            LocalMarketplaceStore.McpTransport.SSE -> callSse(id, request)
            LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP -> callStreamableHttp(id, request)
            else -> throw IllegalStateException("Unsupported transport: $transport")
        }
    }

    // ---- SSE transport ----

    private fun connectSse() {
        val requestBuilder = Request.Builder().url(url).header("Accept", "text/event-stream")
        headers.forEach { (k, v) -> requestBuilder.header(k, v) }

        eventSource = sseFactory.newEventSource(
            requestBuilder.build(),
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    onSseEvent(id, type, data)
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    LOG.warn("[MCP SSE] Connection failure for $serverId: ${t?.message ?: "HTTP ${response?.code}"}")
                }

                override fun onClosed(eventSource: EventSource) {
                    LOG.info("[MCP SSE] Connection closed for $serverId")
                }

                override fun onOpen(eventSource: EventSource, response: Response) {
                    LOG.info("[MCP SSE] Connection opened for $serverId")
                }
            },
        )
    }

    private fun onSseEvent(id: String?, type: String?, data: String) {
        if (data.isBlank()) return

        // Handle endpoint discovery (first event may contain the message endpoint URL)
        if (type == "endpoint" || data.startsWith("/")) {
            messageEndpoint = resolveEndpoint(data.trim())
            LOG.info("[MCP SSE] Message endpoint for $serverId: $messageEndpoint")
            return
        }

        // Parse JSON-RPC response
        val node = try {
            mapper.readTree(data)
        } catch (_: Exception) {
            return
        }

        val idNode = node.get("id")
        if (idNode != null && idNode.isInt) {
            val fut = pending.remove(idNode.asInt())
            if (fut != null) {
                if (node.has("error")) {
                    fut.completeExceptionally(
                        RuntimeException("mcp error: ${node["error"]}")
                    )
                } else {
                    fut.complete(node.get("result") ?: mapper.nullNode())
                }
            }
        }
    }

    private fun callSse(id: Int, request: ObjectNode): JsonNode {
        // Wait for message endpoint if not yet discovered
        val endpoint = waitForEndpoint()
            ?: throw IllegalStateException("SSE message endpoint not discovered for $serverId")

        val fut = CompletableFuture<JsonNode>()
        pending[id] = fut

        val json = mapper.writeValueAsString(request)
        val httpRequest = Request.Builder()
            .url(endpoint)
            .post(json.toRequestBody(JSON_MEDIA_TYPE))
            .header("Content-Type", "application/json")
            .apply { headers.forEach { (k, v) -> header(k, v) } }
            .build()

        try {
            client.newCall(httpRequest).execute().use { response ->
                if (!response.isSuccessful) {
                    pending.remove(id)
                    throw RuntimeException("SSE POST failed: HTTP ${response.code}")
                }
            }
        } catch (e: Exception) {
            pending.remove(id)
            throw e
        }

        return try {
            fut.get(60, TimeUnit.SECONDS)
        } catch (t: Throwable) {
            pending.remove(id)
            throw RuntimeException("MCP SSE call timeout for id $id", t)
        }
    }

    private fun waitForEndpoint(): String? {
        // Wait up to 10s for endpoint discovery
        var waited = 0
        while (messageEndpoint == null && waited < 10000) {
            Thread.sleep(100)
            waited += 100
        }
        return messageEndpoint
    }

    private fun resolveEndpoint(path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        val base = url.substringBeforeLast("/").substringBefore("?")
        return base.trimEnd('/') + "/" + path.trimStart('/')
    }

    // ---- Streamable HTTP transport ----

    private fun callStreamableHttp(id: Int, request: ObjectNode): JsonNode {
        val json = mapper.writeValueAsString(request)
        val httpRequest = Request.Builder()
            .url(url)
            .post(json.toRequestBody(JSON_MEDIA_TYPE))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .apply { headers.forEach { (k, v) -> header(k, v) } }
            .build()

        val response = client.newCall(httpRequest).execute()
        if (!response.isSuccessful) {
            throw RuntimeException("Streamable HTTP call failed: HTTP ${response.code}")
        }

        val contentType = response.header("Content-Type", "") ?: ""
        val body = response.body?.string() ?: throw RuntimeException("Empty response body")

        return if (contentType.contains("text/event-stream")) {
            parseSseResponse(id, body)
        } else {
            // Direct JSON response
            val node = mapper.readTree(body)
            if (node.has("error")) {
                val err = node.get("error")
                throw RuntimeException("mcp error ${err.path("code").asInt()}: ${err.path("message").asText()}")
            }
            node.get("result") ?: mapper.nullNode()
        }
    }

    /** Parse a batch of SSE events from a Streamable HTTP response. */
    private fun parseSseResponse(targetId: Int, body: String): JsonNode {
        var result: JsonNode? = null
        for (block in body.split("\n\n")) {
            var data = ""
            for (line in block.lines()) {
                if (line.startsWith("data:")) {
                    data += line.removePrefix("data:").trim()
                }
            }
            if (data.isBlank()) continue
            val node = try { mapper.readTree(data) } catch (_: Exception) { continue }
            val idNode = node.get("id")
            if (idNode != null && idNode.asInt() == targetId) {
                if (node.has("error")) {
                    val err = node.get("error")
                    throw RuntimeException("mcp error ${err.path("code").asInt()}: ${err.path("message").asText()}")
                }
                result = node.get("result") ?: mapper.nullNode()
            }
        }
        return result ?: throw RuntimeException("No response found for id $targetId in SSE response")
    }

    companion object {
        private val LOG = Logger.getInstance(McpSseClient::class.java)
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}