package io.codepilot.plugin.mcp

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import io.codepilot.plugin.marketplace.LocalMarketplaceStore
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Minimal JSON-RPC 2.0 manager for MCP servers.
 *
 * Supports three transport modes:
 * - **stdio**: Local process communicating via stdin/stdout
 * - **SSE**: Remote server via Server-Sent Events
 * - **Streamable HTTP**: Remote server via HTTP POST
 *
 * Lifetime is tied to the application; stdio processes are lazily launched on first request and
 * reused for subsequent calls. SSE/HTTP clients are managed separately.
 */
@Service(Service.Level.APP)
class McpProcessManager : Disposable {
    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val procs = ConcurrentHashMap<String, Handle>()
    private val specs = ConcurrentHashMap<String, McpLaunchSpec>()
    private val sseClients = ConcurrentHashMap<String, McpSseClient>()
    private val healthScheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val maxRestartAttempts = 3
    private val restartAttempts = ConcurrentHashMap<String, AtomicInteger>()

    init {
        // Schedule periodic health checks every 30 seconds
        healthScheduler.scheduleAtFixedRate({ runHealthChecks() }, 30, 30, TimeUnit.SECONDS)
    }

    /** Call {@code method} with {@code params} on the named MCP server and return the parsed result. */
    fun call(
        serverId: String,
        method: String,
        params: Any?,
        timeoutSeconds: Long = 30,
    ): JsonNode {
        // Try SSE/HTTP client first
        val sseClient = sseClients[serverId]
        if (sseClient != null) {
            return sseClient.call(method, params)
        }
        // Fall back to stdio
        val h = procs[serverId] ?: throw IllegalStateException("mcp not started: $serverId")
        // Fast-fail: if process is already dead, don't bother sending
        if (!h.process.isAlive) {
            throw IOException("MCP process $serverId is dead")
        }
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
        val response = h.awaitResponse(id, timeoutSeconds)
        if (response.has("error")) {
            val err = response.get("error")
            throw RuntimeException("mcp error ${err.path("code").asInt()}: ${err.path("message").asText()}")
        }
        return response.get("result") ?: mapper.nullNode()
    }

    /** Start a stdio-based MCP server. Throws IOException if the process cannot be launched. */
    fun start(
        serverId: String,
        spec: McpLaunchSpec,
    ) {
        specs[serverId] = spec
        restartAttempts.remove(serverId)
        // If there is a dead process from a previous run, clean it up first
        val existing = procs[serverId]
        if (existing != null && !existing.process.isAlive) {
            procs.remove(serverId)
            existing.close()
        }
        // Only launch if not already running
        if (!procs.containsKey(serverId)) {
            procs[serverId] = launch(spec)
        }
    }

    /** Start a remote MCP server (SSE or Streamable HTTP). */
    fun startRemote(
        serverId: String,
        url: String,
        transport: LocalMarketplaceStore.McpTransport,
        headers: Map<String, String> = emptyMap(),
    ) {
        // Disconnect existing client if any
        sseClients.remove(serverId)?.disconnect()
        val client = McpSseClient(serverId, url, transport, headers)
        client.connect()
        sseClients[serverId] = client
    }

    fun stop(serverId: String) {
        specs.remove(serverId)
        restartAttempts.remove(serverId)
        procs.remove(serverId)?.close()
        sseClients.remove(serverId)?.disconnect()
    }

    fun isRunning(serverId: String): Boolean {
        return procs[serverId]?.process?.isAlive == true || sseClients[serverId]?.isConnected == true
    }

    /** Get health status for all running MCP servers. */
    fun healthStatus(): Map<String, HealthStatus> {
        val result = mutableMapOf<String, HealthStatus>()
        for ((id, handle) in procs) {
            result[id] = HealthStatus(
                alive = handle.process.isAlive,
                restartAttempts = restartAttempts[id]?.get() ?: 0,
                serverId = id,
            )
        }
        for ((id, client) in sseClients) {
            result[id] = HealthStatus(
                alive = client.isConnected,
                restartAttempts = 0,
                serverId = id,
            )
        }
        return result
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
        // Resolve argv[0] (e.g. "npx") to full path — IDE process PATH may not include nvm/pnpm
        val resolvedArgv = resolveArgv(spec.argv)
        val pb = ProcessBuilder(resolvedArgv).redirectErrorStream(false)
        spec.cwd?.let { pb.directory(java.io.File(it)) }
        // Merge extended PATH so npx/node/npm etc. are discoverable by child processes
        val env = pb.environment()
        val extraDirs = collectSearchDirs()
        if (extraDirs.isNotEmpty()) {
            val extraPath = extraDirs.joinToString(":")
            val existing = env["PATH"] ?: ""
            env["PATH"] = if (existing.isNotEmpty()) "$extraPath:$existing" else extraPath
        }
        if (spec.env.isNotEmpty()) env.putAll(spec.env)
        val proc = try {
            pb.start()
        } catch (e: IOException) {
            // If launch still fails (e.g. npx not resolved), wrap with a helpful message
            throw IOException("Failed to start MCP '${spec.id}': ${e.message}. " +
                "Resolved argv=$resolvedArgv, PATH=${env["PATH"]?.take(200)}", e)
        }
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

    /**
     * Resolve the first argv element to a full path if it's a bare command like "npx" or "node".
     * This is needed because the IDE process inherits a minimal PATH that may not include nvm/pnpm dirs.
     */
    private fun resolveArgv(argv: List<String>): List<String> {
        if (argv.isEmpty()) return argv
        val cmd = argv[0]
        // Already an absolute path — nothing to resolve
        if (cmd.startsWith("/")) return argv
        // Try to find the command in well-known directories
        val searchDirs = collectSearchDirs()
        for (dir in searchDirs) {
            val candidate = java.io.File(dir, cmd)
            if (candidate.isFile && candidate.canExecute()) {
                return listOf(candidate.absolutePath) + argv.drop(1)
            }
        }
        // Last resort: wrap with /usr/bin/env which does its own PATH lookup
        // This works if we can at least set the PATH env var on the ProcessBuilder
        return listOf("/usr/bin/env") + argv
    }

    /**
     * Collect directories where node/npx/npm might live, including:
     * - User's shell PATH (resolved once and cached)
     * - Common nvm, fnm, homebrew, volta, n install paths
     */
    private var cachedSearchDirs: List<String>? = null

    private fun collectSearchDirs(): List<String> {
        cachedSearchDirs?.let { return it }
        val dirs = mutableListOf<String>()
        // 1. From user's shell PATH
        val shellPath = resolveShellPath()
        if (shellPath.isNotEmpty()) {
            dirs.addAll(shellPath.split(":").filter { it.isNotEmpty() })
        }
        // 2. Common node version manager paths (nvm, fnm, volta, n)
        val home = System.getProperty("user.home") ?: ""
        if (home.isNotEmpty()) {
            // nvm default
            val nvmDir = System.getenv("NVM_DIR") ?: "$home/.nvm"
            val nvmVersions = java.io.File("$nvmDir/versions/node")
            if (nvmVersions.isDirectory) {
                nvmVersions.listFiles()?.filter { it.isDirectory }?.forEach { versionDir ->
                    val binDir = java.io.File(versionDir, "bin")
                    if (binDir.isDirectory) dirs.add(binDir.absolutePath)
                }
            }
            // fnm
            val fnmDir = java.io.File("$home/Library/fnm/node-versions")
            if (fnmDir.isDirectory) {
                fnmDir.listFiles()?.filter { it.isDirectory }?.forEach { versionDir ->
                    val binDir = java.io.File(versionDir, "installation/bin")
                    if (binDir.isDirectory) dirs.add(binDir.absolutePath)
                }
            }
            // volta
            val voltaBin = "$home/.volta/bin"
            if (java.io.File(voltaBin).isDirectory) dirs.add(voltaBin)
            // n
            val nBin = "/usr/local/bin"
            if (java.io.File(nBin).isDirectory) dirs.add(nBin)
        }
        // 3. Homebrew paths
        for (brewPrefix in listOf("/opt/homebrew", "/usr/local")) {
            val binDir = "$brewPrefix/bin"
            if (java.io.File(binDir).isDirectory) dirs.add(binDir)
        }
        cachedSearchDirs = dirs
        return dirs
    }

    /**
     * Resolve the user's shell PATH by running a login shell and echoing $PATH.
     * Cached for the lifetime of the application.
     */
    private var cachedShellPath: String? = null

    private fun resolveShellPath(): String {
        cachedShellPath?.let { return it }
        try {
            val pb = ProcessBuilder("/bin/zsh", "-l", "-c", "echo \$PATH")
            val proc = pb.start()
            val path = proc.inputStream.bufferedReader().readText().trim()
            proc.waitFor(5, TimeUnit.SECONDS)
            if (path.isNotEmpty() && path.contains("/")) {
                cachedShellPath = path
                return path
            }
        } catch (_: Exception) {
            // Fallback: try bash
            try {
                val pb = ProcessBuilder("/bin/bash", "-l", "-c", "echo \$PATH")
                val proc = pb.start()
                val path = proc.inputStream.bufferedReader().readText().trim()
                proc.waitFor(5, TimeUnit.SECONDS)
                if (path.isNotEmpty() && path.contains("/")) {
                    cachedShellPath = path
                    return path
                }
            } catch (_: Exception) {
            }
        }
        return ""
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
        sseClients.values.forEach { it.disconnect() }
        sseClients.clear()
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

        fun awaitResponse(id: Int, timeoutSeconds: Long = 30): JsonNode {
            val fut = java.util.concurrent.CompletableFuture<JsonNode>()
            pending[id] = fut
            return try {
                fut.get(timeoutSeconds, java.util.concurrent.TimeUnit.SECONDS)
            } catch (t: Throwable) {
                pending.remove(id)
                throw RuntimeException("mcp await timeout for id $id", t)
            }
        }

        fun close() {
            runCatching { writer.close() }
            runCatching { process.destroy() }
            // Non-blocking close: don't waitFor on caller thread (could be EDT).
            // Schedule forced destroy as a safety net on a daemon thread.
            val p = process
            val killer = Thread({
                if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    p.destroyForcibly()
                }
            }, "mcp-kill-${process.pid()}")
            killer.isDaemon = true
            killer.start()
        }
    }

    companion object {
        @JvmStatic
        fun getInstance(): McpProcessManager = service()
    }
}
