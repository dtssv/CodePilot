package io.codepilot.harness.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * MCP client for SSE and Streamable HTTP transport modes.
 *
 * Sunk from plugin/mcp/McpSseClient.kt. The original uses OkHttp + OkHttp SSE
 * + Jackson + IntelliJ Logger; here we use java.net.http.HttpClient (JDK 11+),
 * a hand-rolled SSE parser, kotlinx.serialization and slf4j. This keeps
 * harness-core free of OkHttp/IntelliJ dependencies.
 *
 * Transport modes:
 *   - SSE: GET [url] for server→client SSE stream; POST to a discovered
 *          endpoint for client→server. The first SSE event carries the
 *          endpoint path.
 *   - Streamable HTTP: POST to [url], read response directly (JSON or SSE).
 */
class McpSseClient(
    private val serverId: String,
    private val url: String,
    private val transport: McpProcessManager.Transport,
    private val headers: Map<String, String> = emptyMap(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val seq = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
    @Volatile private var messageEndpoint: String? = null
    @Volatile private var sseThread: Thread? = null
    @Volatile private var sseRunning = false

    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    val isConnected: Boolean
        get() = when (transport) {
            McpProcessManager.Transport.SSE -> sseRunning
            McpProcessManager.Transport.STREAMABLE_HTTP -> true
            else -> false
        }

    fun connect() {
        if (transport == McpProcessManager.Transport.SSE) connectSse()
        // Streamable HTTP is stateless
    }

    fun disconnect() {
        sseRunning = false
        sseThread?.interrupt()
        sseThread = null
        messageEndpoint = null
        pending.clear()
    }

    fun call(method: String, params: JsonElement?, timeoutSeconds: Long = 30): JsonElement {
        val id = seq.getAndIncrement()
        val request = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            if (params != null) put("params", params)
        }
        return when (transport) {
            McpProcessManager.Transport.SSE -> callSse(id, request, timeoutSeconds)
            McpProcessManager.Transport.STREAMABLE_HTTP -> callStreamableHttp(id, request)
            else -> throw IllegalStateException("Unsupported transport: $transport")
        }
    }

    // ---- SSE transport ----

    private fun connectSse() {
        sseRunning = true
        val reqBuilder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Accept", "text/event-stream")
            .timeout(Duration.ofSeconds(0)) // long-lived
        headers.forEach { (k, v) -> reqBuilder.header(k, v) }

        sseThread = Thread({
            while (sseRunning) {
                try {
                    val response = httpClient.send(reqBuilder.GET().build(),
                        HttpResponse.BodyHandlers.ofLines())
                    if (response.statusCode() != 200) {
                        LOG.warn("[MCP SSE] {} connect failed: HTTP {}", serverId, response.statusCode())
                        Thread.sleep(1000); continue
                    }
                    response.body().forEach { line ->
                        if (!sseRunning) return@forEach
                        handleSseLine(line)
                    }
                } catch (e: Exception) {
                    if (sseRunning) {
                        LOG.warn("[MCP SSE] {} stream error: {}", serverId, e.message)
                        try { Thread.sleep(1000) } catch (_: InterruptedException) { }
                    }
                }
            }
        }, "mcp-sse-$serverId")
        sseThread?.isDaemon = true
        sseThread?.start()
    }

    private var currentEvent = StringBuilder()

    private fun handleSseLine(line: String) {
        if (line.isBlank()) {
            // Event boundary
            val event = currentEvent.toString().trim()
            currentEvent = StringBuilder()
            if (event.isNotEmpty()) processSseEvent(event)
            return
        }
        currentEvent.append(line).append('\n')
    }

    private fun processSseEvent(raw: String) {
        var data = ""
        var eventType = ""
        for (line in raw.lines()) {
            when {
                line.startsWith("data:") -> data += line.removePrefix("data:").trim()
                line.startsWith("event:") -> eventType = line.removePrefix("event:").trim()
            }
        }
        if (data.isBlank()) return

        // Endpoint discovery event
        if (eventType == "endpoint" || data.startsWith("/")) {
            messageEndpoint = resolveEndpoint(data.trim())
            LOG.info("[MCP SSE] {} message endpoint: {}", serverId, messageEndpoint)
            return
        }

        val node = try { json.parseToJsonElement(data) as? JsonObject } catch (_: Exception) { null } ?: return
        val idNode = node["id"] as? JsonPrimitive ?: return
        val idInt = idNode.content.toIntOrNull() ?: return
        val fut = pending.remove(idInt) ?: return
        if (node.containsKey("error")) fut.completeExceptionally(RuntimeException("mcp error: ${node["error"]}"))
        else fut.complete(node["result"] as? JsonObject ?: JsonObject(emptyMap()))
    }

    private fun callSse(id: Int, request: JsonObject, timeoutSeconds: Long): JsonElement {
        val endpoint = waitForEndpoint()
            ?: throw IllegalStateException("SSE message endpoint not discovered for $serverId")
        val fut = CompletableFuture<JsonObject>()
        pending[id] = fut
        try {
            val reqBuilder = HttpRequest.newBuilder()
                .uri(URI.create(endpoint))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.encodeToString(JsonObject.serializer(), request)))
            headers.forEach { (k, v) -> reqBuilder.header(k, v) }
            val response = httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.discarding())
            if (response.statusCode() !in 200..299) {
                pending.remove(id)
                throw RuntimeException("SSE POST failed: HTTP ${response.statusCode()}")
            }
        } catch (e: Exception) {
            pending.remove(id)
            throw e
        }
        return try {
            fut.get(timeoutSeconds, TimeUnit.SECONDS)
        } catch (t: Throwable) {
            pending.remove(id)
            throw RuntimeException("MCP SSE call timeout for id $id", t)
        }
    }

    private fun waitForEndpoint(): String? {
        var waited = 0
        while (messageEndpoint == null && waited < 10_000) {
            try { Thread.sleep(100) } catch (_: InterruptedException) { return null }
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

    private fun callStreamableHttp(id: Int, request: JsonObject): JsonElement {
        val reqBuilder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(json.encodeToString(JsonObject.serializer(), request)))
        headers.forEach { (k, v) -> reqBuilder.header(k, v) }
        val response = httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299) {
            throw RuntimeException("Streamable HTTP call failed: HTTP ${response.statusCode()}")
        }
        val contentType = response.headers().firstValue("Content-Type").orElse("")
        val body = response.body()
        return if (contentType.contains("text/event-stream")) parseSseResponse(id, body)
        else {
            val node = json.parseToJsonElement(body) as? JsonObject
                ?: throw RuntimeException("invalid JSON response")
            if (node.containsKey("error")) {
                val err = node["error"] as? JsonObject
                val code = (err?.get("code") as? JsonPrimitive)?.content
                val msg = (err?.get("message") as? JsonPrimitive)?.content
                throw RuntimeException("mcp error $code: $msg")
            }
            node["result"] ?: JsonPrimitive("null")
        }
    }

    private fun parseSseResponse(targetId: Int, body: String): JsonElement {
        var result: JsonElement? = null
        for (block in body.split("\n\n")) {
            var data = ""
            for (line in block.lines()) {
                if (line.startsWith("data:")) data += line.removePrefix("data:").trim()
            }
            if (data.isBlank()) continue
            val node = try { json.parseToJsonElement(data) as? JsonObject } catch (_: Exception) { null } ?: continue
            val idNode = node["id"] as? JsonPrimitive ?: continue
            if (idNode.content.toIntOrNull() == targetId) {
                if (node.containsKey("error")) {
                    val err = node["error"] as? JsonObject
                    val code = (err?.get("code") as? JsonPrimitive)?.content
                    val msg = (err?.get("message") as? JsonPrimitive)?.content
                    throw RuntimeException("mcp error $code: $msg")
                }
                result = node["result"] ?: JsonPrimitive("null")
            }
        }
        return result ?: throw RuntimeException("No response found for id $targetId in SSE response")
    }

    companion object {
        private val LOG: Logger = LoggerFactory.getLogger("McpSseClient")
    }
}
