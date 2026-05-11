package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import java.io.BufferedReader
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Minimal JSON-RPC 2.0 manager for MCP servers launched as stdio children.
 *
 * <p>Lifetime is tied to the application; processes are lazily launched on first request and
 * reused for subsequent calls. Callers pass a `spec` that describes how to spawn the child.
 */
@Service(Service.Level.APP)
class McpProcessManager : Disposable {
    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val procs = ConcurrentHashMap<String, Handle>()
    private val specs = ConcurrentHashMap<String, McpLaunchSpec>()
    private val healthScheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val maxRestartAttempts = 3
    private val restartAttempts = ConcurrentHashMap<String, AtomicInteger>()

    init {
        // Schedule periodic health checks every 30 seconds
        healthScheduler.scheduleAtFixedRate({ runHealthChecks() }, 30, 30, TimeUnit.SECONDS)
    }

    /** Call {@code method} with {@code params} on the named MCP child and return the parsed result. */
    fun call(
        serverId: String,
        method: String,
        params: Any?,
    ): JsonNode {
        val h = procs[serverId] ?: throw IllegalStateException("mcp not started: $serverId")
        val id = h.nextId()
        val request: ObjectNode =
            mapper
                .createObjectNode()
                .put("jsonrpc", "2.0")
                .put("id", id)
                .put("method", method)
        if (params != null) request.set<ObjectNode>("params", mapper.valueToTree(params))
        val line = mapper.writeValueAsString(request)
        synchronized(h.lock) {
            h.writer.write(line)
            h.writer.newLine()
            h.writer.flush()
        }
        val response = h.awaitResponse(id)
        if (response.has("error")) {
            val err = response.get("error")
            throw RuntimeException("mcp error ${err.path("code").asInt()}: ${err.path("message").asText()}")
        }
        return response.get("result") ?: mapper.nullNode()
    }

    fun start(
        serverId: String,
        spec: McpLaunchSpec,
    ) {
        specs[serverId] = spec
        restartAttempts.remove(serverId)
        procs.computeIfAbsent(serverId) { launch(spec) }
    }

    fun stop(serverId: String) {
        specs.remove(serverId)
        restartAttempts.remove(serverId)
        procs.remove(serverId)?.close()
    }

    fun isRunning(serverId: String): Boolean = procs[serverId]?.process?.isAlive == true

    /** Get health status for all running MCP servers. */
    fun healthStatus(): Map<String, HealthStatus> =
        procs.mapValues { (id, handle) ->
            val alive = handle.process.isAlive
            val attempts = restartAttempts[id]?.get() ?: 0
            HealthStatus(
                alive = alive,
                restartAttempts = attempts,
                serverId = id,
            )
        }

    data class HealthStatus(
        val alive: Boolean,
        val restartAttempts: Int,
        val serverId: String,
    )

    /** Periodic health check: detect dead processes and attempt auto-restart. */
    private fun runHealthChecks() {
        for ((serverId, handle) in procs) {
            if (!handle.process.isAlive) {
                val attempts = restartAttempts.computeIfAbsent(serverId) { AtomicInteger(0) }
                if (attempts.get() < maxRestartAttempts) {
                    val attempt = attempts.incrementAndGet()
                    com.intellij.openapi.diagnostic.Logger
                        .getInstance("McpProcessManager")
                        .warn("[MCP Health] $serverId is dead, auto-restart attempt $attempt/$maxRestartAttempts")
                    try {
                        val spec = specs[serverId]
                        if (spec != null) {
                            handle.close()
                            val newHandle = launch(spec)
                            procs[serverId] = newHandle
                            // Verify the new process is alive
                            Thread.sleep(1000)
                            if (newHandle.process.isAlive) {
                                attempts.set(0) // Reset on successful restart
                                com.intellij.openapi.diagnostic.Logger
                                    .getInstance("McpProcessManager")
                                    .info("[MCP Health] $serverId restarted successfully")
                            }
                        }
                    } catch (e: Exception) {
                        com.intellij.openapi.diagnostic.Logger
                            .getInstance("McpProcessManager")
                            .warn("[MCP Health] Failed to restart $serverId: ${e.message}")
                    }
                } else {
                    com.intellij.openapi.diagnostic.Logger
                        .getInstance("McpProcessManager")
                        .warn("[MCP Health] $serverId exceeded max restart attempts ($maxRestartAttempts), giving up")
                }
            }
        }
    }

    /** Send a ping request to verify the MCP server is responsive. */
    fun ping(serverId: String): Boolean {
        if (!isRunning(serverId)) return false
        return try {
            val result = call(serverId, "ping", emptyMap<String, Any>())
            !result.isNull
        } catch (e: Exception) {
            com.intellij.openapi.diagnostic.Logger
                .getInstance("McpProcessManager")
                .warn("[MCP Health] Ping failed for $serverId: ${e.message}")
            false
        }
    }

    private fun launch(spec: McpLaunchSpec): Handle {
        val pb = ProcessBuilder(spec.argv).redirectErrorStream(false)
        spec.cwd?.let { pb.directory(java.io.File(it)) }
        if (spec.env.isNotEmpty()) pb.environment().putAll(spec.env)
        val proc = pb.start()
        val writer = java.io.BufferedWriter(java.io.OutputStreamWriter(proc.outputStream, StandardCharsets.UTF_8))
        val handle = Handle(proc, writer)
        val readerThread =
            Thread(
                { pumpStdout(handle, BufferedReader(InputStreamReader(proc.inputStream, StandardCharsets.UTF_8))) },
                "mcp-stdout-${spec.id}",
            )
        readerThread.isDaemon = true
        readerThread.start()
        val errThread = Thread({ drain(proc.errorStream) }, "mcp-stderr-${spec.id}")
        errThread.isDaemon = true
        errThread.start()
        return handle
    }

    private fun pumpStdout(
        handle: Handle,
        reader: BufferedReader,
    ) {
        reader.use { r ->
            while (handle.process.isAlive) {
                val line =
                    try {
                        r.readLine() ?: break
                    } catch (_: Throwable) {
                        break
                    }
                if (line.isBlank()) continue
                val node =
                    try {
                        mapper.readTree(line)
                    } catch (_: Throwable) {
                        continue
                    }
                val idNode = node.get("id")
                if (idNode != null && idNode.isInt) {
                    handle.deliver(idNode.asInt(), node)
                }
            }
        }
    }

    private fun drain(stream: java.io.InputStream) {
        BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { r ->
            while (true) {
                val line =
                    try {
                        r.readLine() ?: break
                    } catch (_: Throwable) {
                        break
                    }
                // stderr is surfaced to idea.log only; MCP outputs never reach the user verbatim.
                com.intellij.openapi.diagnostic.Logger
                    .getInstance("McpProcessManager")
                    .warn("[mcp-stderr] $line")
            }
        }
    }

    override fun dispose() {
        healthScheduler.shutdown()
        try {
            healthScheduler.awaitTermination(5, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
        }
        procs.values.forEach { it.close() }
        procs.clear()
        specs.clear()
        restartAttempts.clear()
    }

    data class McpLaunchSpec(
        val id: String,
        val argv: List<String>,
        val cwd: String? = null,
        val env: Map<String, String> = emptyMap(),
    )

    private class Handle(
        val process: Process,
        val writer: java.io.BufferedWriter,
    ) {
        val lock = Any()
        private val seq = AtomicInteger(1)
        private val pending = ConcurrentHashMap<Int, java.util.concurrent.CompletableFuture<JsonNode>>()
        private val dropped = ConcurrentLinkedQueue<JsonNode>()

        fun nextId(): Int = seq.getAndIncrement()

        fun deliver(
            id: Int,
            body: JsonNode,
        ) {
            val fut =
                pending.remove(id) ?: run {
                    dropped.add(body)
                    return
                }
            fut.complete(body)
        }

        fun awaitResponse(id: Int): JsonNode {
            val fut = java.util.concurrent.CompletableFuture<JsonNode>()
            pending[id] = fut
            return try {
                fut.get(30, java.util.concurrent.TimeUnit.SECONDS)
            } catch (t: Throwable) {
                pending.remove(id)
                throw RuntimeException("mcp await timeout for id $id", t)
            }
        }

        fun close() {
            runCatching { writer.close() }
            runCatching { process.destroy() }
            if (!process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly()
            }
        }
    }

    companion object {
        @JvmStatic fun getInstance(): McpProcessManager = service()
    }
}
