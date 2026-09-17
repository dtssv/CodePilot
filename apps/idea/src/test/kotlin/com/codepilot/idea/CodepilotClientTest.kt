package com.codepilot.idea

import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.TimeUnit

/**
 * Pure unit tests for [CodepilotClient] — no IDE fixture. The client's stdout reader is spied with
 * a MockK-recording sink so tests can assert on the exact NDJSON frames the client writes.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class CodepilotClientTest {

    private val gson = Gson()

    /** Sink installed via MockK that captures every frame the client writes and forwards to stdin. */
    private class WriteSink {
        private val buf = java.io.ByteArrayOutputStream()
        val written = mutableListOf<String>()

        @Synchronized
        fun write(s: String) {
            written += s
            buf.write(s.toByteArray(Charsets.UTF_8))
            buf.write('\n'.code)
        }

        fun stream(): java.io.InputStream = java.io.ByteArrayInputStream(buf.toByteArray())
    }

    private var client: CodepilotClient? = null
    private var bridge: FakeCodepilotServer.Bridge? = null

    @AfterEach
    fun tearDown() {
        runCatching { client?.shutdown() }
        runCatching { bridge?.stop() }
        client = null
        bridge = null
    }

    // ---------- helpers ----------

    private fun startClient(
        behavior: FakeCodepilotServer.Behavior,
        sink: WriteSink = WriteSink(),
    ): CodepilotClient {
        val installed = FakeCodepilotServer.install(behavior)
        bridge = FakeCodepilotServer.startBridge(installed, behavior)

        val c = CodepilotClient(installed.command, installed.workingDir.absolutePath)
        c.start()

        // Tee the client's stdin writer into [sink] so tests can assert on the exact NDJSON
        // frames the client produces. We reflect on the private `writer` field (set by start())
        // and swap in a BufferedWriter whose underlying stream records-then-forwards.
        val writerField = CodepilotClient::class.java.getDeclaredField("writer")
        writerField.isAccessible = true
        val realWriter = writerField.get(c) as java.io.BufferedWriter
        val tee = TeeOutputStream(realWriter, sink)
        writerField.set(c, java.io.BufferedWriter(java.io.OutputStreamWriter(tee, Charsets.UTF_8)))

        client = c
        return c
    }

    /** OutputStream that mirrors every write into [sink] and forwards to the real process stdin. */
    private class TeeOutputStream(
        private val delegate: java.io.BufferedWriter,
        private val sink: WriteSink,
    ) : java.io.OutputStream() {
        override fun write(b: Int) {
            delegate.write(b)
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            // The client writes whole NDJSON frames via BufferedWriter.write(String) →
            // OutputStreamWriter converts to bytes here. Record the chunk as text and forward.
            sink.write(String(b, off, len, Charsets.UTF_8))
            val charset = Charsets.UTF_8
            delegate.write(String(b, off, len, charset))
        }

        override fun flush() = delegate.flush()
        override fun close() = delegate.close()
    }

    private fun defaultBehavior(): FakeCodepilotServer.Behavior = FakeCodepilotServer.Behavior(
        responder = { method, _ ->
            when (method) {
                "initialize" -> JsonObject().apply {
                    addProperty("protocolVersion", 1)
                    add("capabilities", JsonObject().apply {
                        add("tools", com.google.gson.JsonArray().apply { add("bash"); add("edit") })
                        add("providers", com.google.gson.JsonArray().apply { add("anthropic") })
                        add("modes", com.google.gson.JsonArray().apply {
                            add("chat"); add("plan"); add("agent")
                        })
                    })
                }
                "session/new" -> JsonObject().apply { addProperty("sessionId", "sess-123") }
                "session/list" -> JsonObject().apply {
                    add("sessions", com.google.gson.JsonArray().apply {
                        add(JsonObject().apply {
                            addProperty("id", "sess-1")
                            addProperty("title", "First")
                            addProperty("updatedAt", 1_700_000_000_000L)
                            addProperty("cwd", "/tmp/a")
                        })
                        add(JsonObject().apply {
                            addProperty("id", "sess-2")
                            addProperty("title", "")
                            addProperty("updatedAt", 2L)
                            addProperty("cwd", "/tmp/b")
                        })
                    })
                }
                "session/resume" -> JsonObject().apply {
                    addProperty("sessionId", "sess-123")
                    add("events", com.google.gson.JsonArray().apply {
                        add(JsonObject().apply { addProperty("type", "message") })
                    })
                }
                "session/fork" -> JsonObject().apply { addProperty("sessionId", "sess-forked") }
                "session/setMode" -> JsonObject()
                "permission/respond", "question/respond" -> JsonObject()
                "shutdown" -> JsonObject()
                else -> null
            }
        },
    )

    // ---------- 1. Serialization / deserialization ----------

    @Test
    fun `initialize serializes protocol frame and parses capabilities`() {
        val sink = WriteSink()
        val c = startClient(defaultBehavior(), sink)

        val result = c.initialize(cwd = "/repo", permissionMode = "ask", clientName = "Test", clientVersion = "9.9")

        assertEquals(1, result.protocolVersion)
        assertEquals(listOf("bash", "edit"), result.tools)
        assertEquals(listOf("anthropic"), result.providers)
        assertEquals(listOf("chat", "plan", "agent"), result.modes)

        // The client must have written a well-formed JSON-RPC request frame.
        assertTrue(sink.written.any { it.contains("\"method\":\"initialize\"") })
        val frame = sink.written.first { it.contains("\"method\":\"initialize\"") }
        val parsed = gson.fromJson(frame, JsonObject::class.java)
        assertEquals("2.0", parsed.get("jsonrpc").asString)
        assertTrue(parsed.has("id"))
        val params = parsed.getAsJsonObject("params")
        assertEquals("/repo", params.get("cwd").asString)
        assertEquals("ask", params.get("permissionMode").asString)
        assertEquals("Test", params.getAsJsonObject("clientInfo").get("name").asString)
    }

    @Test
    fun `listSessions deserializes session summaries`() {
        val c = startClient(defaultBehavior())
        c.initialize("/repo", "ask")

        val sessions = c.listSessions()
        assertEquals(2, sessions.size)
        assertEquals(SessionSummary("sess-1", "First", 1_700_000_000_000L, "/tmp/a"), sessions[0])
        assertEquals(SessionSummary("sess-2", "", 2L, "/tmp/b"), sessions[1])
    }

    // ---------- 2. Request/response correlation (id matching) ----------

    @Test
    fun `concurrent requests are correlated by id`() {
        // Two overlapping requests — the server replies in reverse order. The client must route
        // each response to the right pending deferred.
        val behavior = FakeCodepilotServer.Behavior(
            responder = { method, params ->
                when (method) {
                    "initialize" -> JsonObject().apply { addProperty("protocolVersion", 1) }
                    "slow" -> JsonObject().apply { addProperty("echo", params.get("tag").asString + "-slow") }
                    "fast" -> JsonObject().apply { addProperty("echo", params.get("tag").asString + "-fast") }
                    else -> null
                }
            },
            delaysMs = mapOf("slow" to 400L, "fast" to 0L),
        )
        val c = startClient(behavior)
        c.initialize("/repo", "ask")

        val slowResult = java.util.concurrent.CompletableFuture<JsonObject?>()
        val fastResult = java.util.concurrent.CompletableFuture<JsonObject?>()

        Thread { slowResult.complete(sendRequestRaw(c, "slow", JsonObject().apply { addProperty("tag", "a") }, 5_000L)) }.start()
        Thread.sleep(50) // ensure `slow` is registered first
        Thread { fastResult.complete(sendRequestRaw(c, "fast", JsonObject().apply { addProperty("tag", "b") }, 5_000L)) }.start()

        assertEquals("a-slow", slowResult.get(5, TimeUnit.SECONDS)?.get("echo")?.asString)
        assertEquals("b-fast", fastResult.get(5, TimeUnit.SECONDS)?.get("echo")?.asString)
    }

    // ---------- 3. Server-initiated request handling ----------

    @Test
    fun `permission slash request is surfaced as ServerRequest and acked`() = runBlocking {
        val permReqId = 777L
        val reverseFrame = gson.toJson(JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", permReqId)
            addProperty("method", "permission/request")
            add("params", JsonObject().apply {
                addProperty("sessionId", "sess-123")
                addProperty("requestId", "req-abc")
                addProperty("tool", "bash")
            })
        })
        val behavior = defaultBehavior().copyWith(afterInitialize = listOf(reverseFrame))
        val sink = WriteSink()
        val c = startClient(behavior, sink)

        // Trigger the handshake; the fake server then pushes the reverse request.
        c.initialize("/repo", "ask")

        val msg = withTimeout(5_000) {
            c.events.first { it is IncomingMessage.ServerRequest }
        } as IncomingMessage.ServerRequest

        assertEquals(permReqId, msg.id)
        assertEquals("permission/request", msg.method)
        assertEquals("sess-123", msg.params.get("sessionId").asString)
        assertEquals("req-abc", msg.params.get("requestId").asString)

        // Ack the reverse request itself + send the decision.
        c.ackServerRequest(msg.id)
        c.respondPermission("req-abc", "allow")

        // Wait until both frames have been flushed to the sink.
        withTimeout(5_000) {
            while (true) {
                val acked = sink.written.any {
                    it.contains("\"id\":$permReqId") && it.contains("\"result\":{}")
                }
                val responded = sink.written.any { it.contains("\"method\":\"permission/respond\"") }
                if (acked && responded) break
                kotlinx.coroutines.delay(50)
            }
        }

        // Verify the ack frame shape: {jsonrpc:"2.0", id:777, result:{}}.
        val ackFrame = sink.written.first { it.contains("\"id\":$permReqId") && it.contains("\"result\":{}") }
        val parsedAck = gson.fromJson(ackFrame, JsonObject::class.java)
        assertEquals("2.0", parsedAck.get("jsonrpc").asString)
        assertEquals(permReqId, parsedAck.get("id").asLong)
        assertTrue(parsedAck.getAsJsonObject("result").entrySet().isEmpty())

        // Verify the respond frame.
        val respFrame = sink.written.first { it.contains("\"method\":\"permission/respond\"") }
        val parsedResp = gson.fromJson(respFrame, JsonObject::class.java)
        val params = parsedResp.getAsJsonObject("params")
        assertEquals("req-abc", params.get("requestId").asString)
        assertEquals("allow", params.get("decision").asString)
    }

    @Test
    fun `question slash request is surfaced as ServerRequest`() = runBlocking {
        val qFrame = gson.toJson(JsonObject().apply {
            addProperty("jsonrpc", "2.0")
            addProperty("id", 888L)
            addProperty("method", "question/request")
            add("params", JsonObject().apply {
                addProperty("sessionId", "sess-9")
                addProperty("requestId", "q-1")
            })
        })
        val behavior = defaultBehavior().copyWith(afterInitialize = listOf(qFrame))
        val c = startClient(behavior)
        c.initialize("/repo", "ask")

        val msg = withTimeout(5_000) {
            c.events.first { it is IncomingMessage.ServerRequest && it.method == "question/request" }
        } as IncomingMessage.ServerRequest

        assertEquals(888L, msg.id)
        assertEquals("sess-9", msg.params.get("sessionId").asString)
    }

    // ---------- 4. NDJSON line parsing (partial lines, multiple lines per chunk) ----------

    @Test
    fun `response split into tiny chunks is reassembled`() {
        // Chunk size 7 forces the client to stitch the NDJSON line back together.
        val behavior = defaultBehavior().copyWith(chunkSize = 7, chunkDelayMs = 2)
        val c = startClient(behavior)

        val result = c.initialize("/repo", "ask")
        assertEquals(1, result.protocolVersion)

        // Also verify a subsequent request still parses correctly on the same stream.
        assertEquals("sess-123", c.newSession())
    }

    @Test
    fun `multiple notifications in one chunk are all delivered`() = runBlocking {
        val note1 = gson.toJson(JsonObject().apply {
            addProperty("method", "event")
            add("params", JsonObject().apply {
                addProperty("sessionId", "sess-123")
                addProperty("type", "delta")
                addProperty("n", 1)
            })
        })
        val note2 = gson.toJson(JsonObject().apply {
            addProperty("method", "event")
            add("params", JsonObject().apply {
                addProperty("sessionId", "sess-123")
                addProperty("type", "delta")
                addProperty("n", 2)
            })
        })
        // afterInitialize lines are written back-to-back — the reader loop must handle both.
        val behavior = defaultBehavior().copyWith(afterInitialize = listOf(note1, note2))
        val c = startClient(behavior)
        c.initialize("/repo", "ask")

        val received = mutableListOf<Int>()
        withTimeout(5_000) {
            c.events.first { msg ->
                if (msg is IncomingMessage.Notification && msg.method == "event") {
                    received += msg.params.get("n").asInt
                }
                received.size >= 2
            }
        }
        assertEquals(listOf(1, 2), received.sorted())
    }

    // ---------- 5. Error response handling ----------

    @Test
    fun `json-rpc error response throws IllegalStateException with code and message`() {
        val behavior = FakeCodepilotServer.Behavior(
            responder = { method, _ ->
                when (method) {
                    "initialize" -> JsonObject().apply { addProperty("protocolVersion", 1) }
                    // Server reports a proper JSON-RPC error for `boom` (Invalid params).
                    "boom" -> FakeCodepilotServer.errorFrame(-32602, "Invalid params")
                    else -> null
                }
            },
        )
        val c = startClient(behavior)
        c.initialize("/repo", "ask")

        val ex = assertThrows<IllegalStateException> { sendRequestRaw(c, "boom", JsonObject(), 5_000L) }
        assertTrue(ex.message!!.contains("-32602"), "expected error code in message, got: ${ex.message}")
        assertTrue(ex.message!!.contains("Invalid params"), "expected error message, got: ${ex.message}")
    }

    // ---------- 6. Timeout behavior ----------

    @Test
    fun `request that exceeds timeout returns null from sendRequest`() {
        val behavior = FakeCodepilotServer.Behavior(
            responder = { method, _ ->
                when (method) {
                    "initialize" -> JsonObject().apply { addProperty("protocolVersion", 1) }
                    "session/new" -> JsonObject().apply { addProperty("sessionId", "too-late") }
                    else -> null
                }
            },
            // Server answers after 2 s; the client call below times out after 200 ms.
            delaysMs = mapOf("session/new" to 2_000L),
        )
        val c = startClient(behavior)
        c.initialize("/repo", "ask")

        val result = sendRequestRaw(c, "session/new", JsonObject(), 200L)
        assertEquals(null, result)
    }

    // ---------- misc protocol helpers ----------

    @Test
    fun `resumeSession and forkSession parse responses`() {
        val c = startClient(defaultBehavior())
        c.initialize("/repo", "ask")

        val resume = c.resumeSession("sess-123")
        assertEquals("sess-123", resume.sessionId)
        assertEquals(1, resume.events.size)
        assertEquals("message", resume.events[0].get("type").asString)

        assertEquals("sess-forked", c.forkSession("sess-123", atEventIndex = 3))
    }

    @Test
    fun `sessionEvents fans out per-session messages`() = runBlocking {
        // The server pushes sess-A / sess-B events *lazily*: only after it receives a
        // `prompt/send` notification. This guarantees the client has already created the
        // per-session channel before the events arrive.
        val noteForA = gson.toJson(JsonObject().apply {
            addProperty("method", "event")
            add("params", JsonObject().apply {
                addProperty("sessionId", "sess-A")
                addProperty("type", "done")
            })
        })
        val noteForB = gson.toJson(JsonObject().apply {
            addProperty("method", "event")
            add("params", JsonObject().apply {
                addProperty("sessionId", "sess-B")
                addProperty("type", "done")
            })
        })
        val behavior = FakeCodepilotServer.Behavior(
            responder = { method, _ ->
                when (method) {
                    "initialize" -> JsonObject().apply { addProperty("protocolVersion", 1) }
                    else -> JsonObject()
                }
            },
            afterPrompt = mapOf(
                "sess-A" to listOf(noteForA),
                "sess-B" to listOf(noteForB),
            ),
        )
        val c = startClient(behavior)
        c.initialize("/repo", "ask")

        // Subscribe first — creates the per-session channel.
        val aEvents = c.sessionEvents("sess-A")

        // Trigger the server to push the sess-A event (sess-B's event must not leak into this flow).
        c.sendPrompt("sess-A", "go")
        c.sendPrompt("sess-B", "go")

        val first = withTimeout(5_000) { aEvents.first() }
        assertNotNull(first)
        assertEquals("sess-A", first.sessionId)
    }

    // ---------- test utilities ----------

    /** Invoke the client's private sendRequest(method, params, timeoutMs) via reflection. */
    private fun sendRequestRaw(
        client: CodepilotClient,
        method: String,
        params: JsonObject,
        timeoutMs: Long,
    ): JsonObject? {
        val m = CodepilotClient::class.java.getDeclaredMethod(
            "sendRequest", String::class.java, JsonObject::class.java, Long::class.javaPrimitiveType,
        )
        m.isAccessible = true
        return try {
            m.invoke(client, method, params, timeoutMs) as JsonObject?
        } catch (e: java.lang.reflect.InvocationTargetException) {
            throw (e.cause ?: e)
        }
    }

    private fun FakeCodepilotServer.Behavior.copyWith(
        afterInitialize: List<String>? = null,
        chunkSize: Int? = null,
        chunkDelayMs: Long? = null,
        delaysMs: Map<String, Long>? = null,
    ) = FakeCodepilotServer.Behavior(
        responder = this.responder,
        afterInitialize = afterInitialize ?: this.afterInitialize,
        delaysMs = delaysMs ?: this.delaysMs,
        chunkSize = chunkSize ?: this.chunkSize,
        chunkDelayMs = chunkDelayMs ?: this.chunkDelayMs,
    )
}
