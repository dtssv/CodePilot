package com.codepilot.idea

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.reflect.TypeToken
import com.intellij.openapi.diagnostic.logger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Client for the headless `codepilot serve` JSON-RPC process (see docs/PROTOCOL.md).
 *
 * Lifecycle:
 *   1. [start] — spawn the process and read stdout in a background coroutine.
 *   2. [initialize] — protocol handshake.
 *   3. [newSession] / [resumeSession] / [prompt] / [cancel] / [respondPermission].
 *   4. [shutdown] — graceful close, then destroy.
 *
 * Threading:
 *   - All writes are serialized through [writeChannel].
 *   - The read loop runs on [Dispatchers.IO]; events are emitted to subscribers via [events].
 */
class CodepilotClient(
    /** Resolved executable + args for `codepilot serve`. */
    private val command: List<String>,
    /** Working directory for the spawned process. */
    private val workingDir: String,
    /** Optional env overrides (e.g. ANTHROPIC_API_KEY). */
    private val envOverrides: Map<String, String> = emptyMap(),
) {
    private val gson = Gson()
    private val log = logger<CodepilotClient>()
    private val idGen = AtomicLong(1L)
    private val pending = ConcurrentHashMap<Long, CompletableDeferredJson>()
    /** sessionId → active prompt generation (used so we can correlate incoming events). */
    private val sessionGenerations = ConcurrentHashMap<String, Long>()

    private var process: Process? = null
    private var writer: BufferedWriter? = null
    private var reader: BufferedReader? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val writeChannel = Channel<String>(capacity = Channel.UNLIMITED)

    /** Notifications / unsolicited requests / streamed events. */
    private val eventChannel = Channel<IncomingMessage>(capacity = Channel.BUFFERED)
    val events: Flow<IncomingMessage> = eventChannel.receiveAsFlow()

    /** Per-session prompt stream: sessionId → sub-channel so we can fan-out per-session if needed. */
    private val sessionChannels = ConcurrentHashMap<String, Channel<IncomingMessage>>()

    val isRunning: Boolean get() = process?.isAlive == true

    // ---------- Lifecycle ----------

    fun start() {
        if (process != null) return
        val pb = ProcessBuilder(command).directory(java.io.File(workingDir))
        // Inherit PATH but add user-provided overrides last so they win.
        pb.environment().putAll(envOverrides)
        val p = pb.start()
        process = p
        writer = BufferedWriter(OutputStreamWriter(p.outputStream, StandardCharsets.UTF_8))
        reader = BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8))

        // Writer pump — coroutine safe, writes from multiple callers serialize through [writeChannel].
        scope.launch {
            try {
                for (msg in writeChannel) {
                    writer!!.write(msg)
                    writer!!.newLine()
                    writer!!.flush()
                }
            } catch (t: Throwable) {
                if (isActive) {
                    eventChannel.trySend(IncomingMessage.Failure(t.message ?: "writer died", t))
                }
            }
        }

        // Reader pump.
        scope.launch {
            try {
                while (isActive) {
                    val line = withContext(Dispatchers.IO) { reader!!.readLine() } ?: break
                    if (line.isBlank()) continue
                    val msg = parseLine(line)
                    if (msg != null) {
                        if (msg is IncomingMessage.Response) {
                            pending.remove(msg.id)?.complete(msg)
                        }
                        // Always deliver to the global channel (UI hooks live here).
                        eventChannel.trySend(msg)
                        // Also fan out per-session for prompt subscribers.
                        msg.sessionId?.let { sid ->
                            sessionChannels[sid]?.trySend(msg)
                        }
                    }
                }
            } catch (t: Throwable) {
                eventChannel.trySend(IncomingMessage.Failure(t.message ?: "reader died", t))
            } finally {
                eventChannel.close()
            }
        }

        // Process exit watcher — close channels and fail pending requests.
        scope.launch {
            try {
                p.waitFor()
            } catch (_: InterruptedException) {
                // Ignore — we asked for it.
            } finally {
                pending.values.forEach { it.fail(IllegalStateException("process exited")) }
                pending.clear()
            }
        }
    }

    fun shutdown() {
        runCatching { sendRequest("shutdown", JsonObject(), timeoutMs = 2_000) }
        runCatching { sendNotification("exit", JsonObject()) }
        process?.destroy()
        if (process?.isAlive == true) {
            process?.destroyForcibly()
        }
        process = null
        writer = null
        reader = null
        scope.cancel()
    }

    // ---------- Protocol helpers ----------

    fun initialize(cwd: String, permissionMode: String, clientName: String = "CodePilot IDEA", clientVersion: String = "0.1.0"): InitializeResult {
        val args = JsonObject().apply {
            addProperty("protocolVersion", 1)
            addProperty("cwd", cwd)
            addProperty("permissionMode", permissionMode)
            val info = JsonObject().apply {
                addProperty("name", clientName)
                addProperty("version", clientVersion)
            }
            add("clientInfo", info)
        }
        val result = sendRequest("initialize", args) ?: error("initialize timed out")
        val capabilities = result.getAsJsonObject("capabilities")
        return InitializeResult(
            protocolVersion = result.get("protocolVersion")?.asInt ?: 1,
            tools = capabilities?.getAsJsonArray("tools")?.map { it.asString } ?: emptyList(),
            providers = capabilities?.getAsJsonArray("providers")?.map { it.asString } ?: emptyList(),
            modes = capabilities?.getAsJsonArray("modes")?.map { it.asString } ?: listOf("chat", "plan", "agent"),
        )
    }

    fun newSession(
        cwd: String? = null,
        model: String? = null,
        systemPromptExtra: String? = null,
        agentMode: String? = null,
    ): String {
        val args = JsonObject().apply {
            cwd?.let { addProperty("cwd", it) }
            model?.let { addProperty("model", it) }
            systemPromptExtra?.let { addProperty("systemPromptExtra", it) }
            agentMode?.let { addProperty("agentMode", it) }
        }
        val r = sendRequest("session/new", args) ?: error("session/new timed out")
        return r.get("sessionId").asString
    }

    /**
     * Switch the collaboration mode for an already-open session (Cursor-style Ask/Plan/Agent).
     * Server immediately emits a `{type:"mode", mode}` event to acknowledge.
     * Returns true on success; false if the server rejected with SessionNotFound / InvalidParams.
     */
    fun setMode(sessionId: String, mode: String): Boolean {
        val args = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("mode", mode)
        }
        return try {
            sendRequest("session/setMode", args, timeoutMs = 5_000) != null
        } catch (t: Throwable) {
            log.warn("setMode($mode) failed: ${t.message}", t)
            false
        }
    }

    fun resumeSession(sessionId: String): ResumeResult {
        val args = JsonObject().apply { addProperty("sessionId", sessionId) }
        val r = sendRequest("session/resume", args) ?: error("session/resume timed out")
        val eventsType = object : TypeToken<List<JsonObject>>() {}.type
        val list: List<JsonObject> = gson.fromJson(r.getAsJsonArray("events"), eventsType) ?: emptyList()
        return ResumeResult(sessionId = r.get("sessionId").asString, events = list)
    }

    fun listSessions(): List<SessionSummary> {
        val r = sendRequest("session/list", JsonObject()) ?: error("session/list timed out")
        val arr = r.getAsJsonArray("sessions") ?: return emptyList()
        val type = object : TypeToken<List<JsonObject>>() {}.type
        val raw: List<JsonObject> = gson.fromJson(arr, type)
        return raw.map {
            SessionSummary(
                id = it.get("id").asString,
                title = it.get("title")?.asString ?: "",
                updatedAt = it.get("updatedAt")?.asLong ?: 0L,
                cwd = it.get("cwd")?.asString ?: "",
            )
        }
    }

    fun sendPrompt(sessionId: String, text: String, images: List<Pair<String, String>>? = null) {
        val args = JsonObject().apply {
            addProperty("sessionId", sessionId)
            addProperty("text", text)
            if (images != null && images.isNotEmpty()) {
                val arr = com.google.gson.JsonArray()
                images.forEach { (mediaType, base64) ->
                    arr.add(JsonObject().apply {
                        addProperty("mediaType", mediaType)
                        addProperty("base64", base64)
                    })
                }
                add("images", arr)
            }
        }
        sendNotification("prompt/send", args)
    }

    fun cancelPrompt(sessionId: String) {
        val args = JsonObject().apply { addProperty("sessionId", sessionId) }
        sendNotification("prompt/cancel", args)
    }

    fun respondPermission(requestId: String, decision: String) {
        val args = JsonObject().apply {
            addProperty("requestId", requestId)
            addProperty("decision", decision)
        }
        // Must be a request (not notification): the server registers
        // `permission/respond` via onRequest and resolves the pending
        // permission promise from its handler.
        sendRequest("permission/respond", args)
    }

    /**
     * Answer a `question/request` (ask_user_question / plan_done).
     * `answers` maps question id → option label / labels / free text.
     */
    fun respondQuestion(requestId: String, answers: JsonObject) {
        val args = JsonObject().apply {
            addProperty("requestId", requestId)
            add("answers", answers)
        }
        sendRequest("question/respond", args)
    }

    /**
     * Ack a server-initiated reverse request (`permission/request`,
     * `question/request`). Per PROTOCOL.md the client must reply to the
     * request frame itself (empty result) AND send the actual decision via
     * `*/respond`; skipping the ack leaks the server-side request promise.
     */
    fun ackServerRequest(id: Long) {
        val frame = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", id)
            add("result", JsonObject())
        }
        writeChannel.trySend(gson.toJson(frame))
    }

    fun forkSession(sessionId: String, atEventIndex: Int? = null): String {
        val args = JsonObject().apply {
            addProperty("sessionId", sessionId)
            atEventIndex?.let { addProperty("atEventIndex", it) }
        }
        val r = sendRequest("session/fork", args) ?: error("session/fork timed out")
        return r.get("sessionId").asString
    }

    // ---------- Transport internals ----------

    private fun sendRequest(method: String, params: JsonObject, timeoutMs: Long = 30_000): JsonObject? {
        val id = idGen.getAndIncrement()
        val frame = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", id)
            addProperty("method", method)
            add("params", params)
        }
        val deferred = CompletableDeferredJson()
        pending[id] = deferred
        val payload = gson.toJson(frame)
        // Try to enqueue; fall back to blocking send if channel closed.
        val ok = writeChannel.trySend(payload).isSuccess
        if (!ok) {
            pending.remove(id)
            throw IllegalStateException("client shut down")
        }
        return runBlocking { deferred.awaitOrNull(timeoutMs) }
    }

    private fun sendNotification(method: String, params: JsonObject) {
        val frame = JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("method", method)
            add("params", params)
        }
        val payload = gson.toJson(frame)
        writeChannel.trySend(payload)
    }

    private fun parseLine(line: String): IncomingMessage? {
        return try {
            val obj = JsonParser.parseString(line).asJsonObject
            if (obj.has("id") && obj.has("result")) {
                val id = obj.get("id").asLong
                val result = obj.getAsJsonObject("result")
                IncomingMessage.Response(id, result)
            } else if (obj.has("id") && obj.has("error")) {
                val id = obj.get("id").asLong
                val err = obj.getAsJsonObject("error")
                IncomingMessage.Error(id, err)
            } else if (obj.has("method")) {
                // Server-to-client notifications have no `id`; reverse requests (permission/request) do.
                val method = obj.get("method").asString
                val params = obj.getAsJsonObject("params")
                val idToken = if (obj.has("id")) obj.get("id").asLong else null
                if (idToken != null) {
                    IncomingMessage.ServerRequest(idToken, method, params)
                } else {
                    IncomingMessage.Notification(method, params)
                }
            } else {
                null
            }
        } catch (t: Throwable) {
            IncomingMessage.Failure("malformed line: $line", t)
        }
    }

    /** Subscribe to messages for a specific sessionId. Used by [ChatPanel]. */
    fun sessionEvents(sessionId: String): Flow<IncomingMessage> = callbackFlow {
        val channel = sessionChannels.computeIfAbsent(sessionId) { Channel(capacity = Channel.BUFFERED) }
        val job: Job = launch(Dispatchers.IO) {
            try {
                for (msg in channel) {
                    send(msg)
                }
            } catch (_: Throwable) {
                // Channel closed.
            }
        }
        awaitClose {
            job.cancel()
            // Don't remove from map — other subscribers may exist.
        }
    }
}

/** Lightweight JSON-RPC deferred (we don't pull in a full lib for one await primitive). */
private class CompletableDeferredJson {
    private val lock = Object()
    private var value: IncomingMessage.Response? = null
    private var error: IncomingMessage.Error? = null
    private var done = false

    fun complete(msg: IncomingMessage.Response) = synchronized(lock) {
        value = msg; done = true; lock.notifyAll()
    }

    fun fail(t: Throwable) = synchronized(lock) {
        // Wrap into a synthetic JSON-RPC error so the caller's null-handling still works.
        error = IncomingMessage.Error(-1, JsonObject().apply {
            addProperty("code", -32603); addProperty("message", t.message ?: "internal")
        })
        done = true; lock.notifyAll()
    }

    fun awaitOrNull(timeoutMs: Long): JsonObject? {
        val deadline = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (!done) {
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) return null
                lock.wait(remaining)
            }
            return error?.let {
                throw IllegalStateException("JSON-RPC error ${it.error.get("code")?.asInt}: ${it.error.get("message")?.asString}")
            } ?: value?.result
        }
    }
}

/** Strongly-typed result of `initialize`. */
data class InitializeResult(
    val protocolVersion: Int,
    val tools: List<String>,
    val providers: List<String>,
    val modes: List<String>,
)

data class ResumeResult(val sessionId: String, val events: List<JsonObject>)

data class SessionSummary(val id: String, val title: String, val updatedAt: Long, val cwd: String)

/** Incoming JSON-RPC payload (response, error, notification, request, or stream failure). */
sealed class IncomingMessage {
    abstract val sessionId: String?

    data class Response(val id: Long, val result: JsonObject) : IncomingMessage() {
        override val sessionId: String? = result.get("sessionId")?.asString
    }

    data class Error(val id: Long, val error: JsonObject) : IncomingMessage() {
        override val sessionId: String? = null
    }

    /** Server-initiated *request* (carries an id — we must reply). Used for `permission/request`. */
    data class ServerRequest(val id: Long, val method: String, val params: JsonObject) : IncomingMessage() {
        override val sessionId: String? = params?.get("sessionId")?.asString
    }

    /** Server-initiated *notification* (no id — fire-and-forget). Used for `event`, `session/usage`. */
    data class Notification(val method: String, val params: JsonObject) : IncomingMessage() {
        override val sessionId: String? = params?.get("sessionId")?.asString
    }

    data class Failure(val message: String, val cause: Throwable? = null) : IncomingMessage() {
        override val sessionId: String? = null
    }
}