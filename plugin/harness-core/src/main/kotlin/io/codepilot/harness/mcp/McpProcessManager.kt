package io.codepilot.harness.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Minimal JSON-RPC 2.0 manager for MCP servers (stdio + SSE + Streamable HTTP).
 *
 * Sunk from plugin/mcp/McpProcessManager.kt. The original is a IntelliJ
 * `@Service(Level.APP)` with `Disposable`; here we use slf4j and implement
 * `AutoCloseable` so the IDE adapter can tie lifetime to a project. The
 * transport mode enum is local ([Transport]) instead of depending on
 * LocalMarketplaceStore.McpTransport.
 *
 * JSON is kotlinx.serialization (no Jackson). HTTP is java.net.http.HttpClient
 * (no OkHttp) so harness-core has zero Android/IntelliJ-only deps.
 */
class McpProcessManager : AutoCloseable {

    private val log: Logger = LoggerFactory.getLogger("McpProcessManager")
    private val json = Json { ignoreUnknownKeys = true }

    private val procs = ConcurrentHashMap<String, Handle>()
    private val specs = ConcurrentHashMap<String, McpLaunchSpec>()
    private val sseClients = ConcurrentHashMap<String, McpSseClient>()
    private val healthScheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "mcp-health").apply { isDaemon = true }
    }
    private val maxRestartAttempts = 3
    private val restartAttempts = ConcurrentHashMap<String, AtomicInteger>()

    enum class Transport { STDIO, SSE, STREAMABLE_HTTP }

    init {
        healthScheduler.scheduleAtFixedRate({ runHealthChecks() }, 30, 30, TimeUnit.SECONDS)
    }

    /** Call [method] with [params] on the named MCP server; returns the parsed result. */
    fun call(
        serverId: String,
        method: String,
        params: JsonElement? = null,
        timeoutSeconds: Long = 30,
    ): JsonElement {
        // Try SSE/HTTP client first
        val sseClient = sseClients[serverId]
        if (sseClient != null) return sseClient.call(method, params, timeoutSeconds)

        val h = procs[serverId] ?: throw IllegalStateException("mcp not started: $serverId")
        if (!h.process.isAlive) throw IOException("MCP process $serverId is dead")

        val id = h.nextId()
        val request = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            if (params != null) put("params", params)
        }
        val line = json.encodeToString(JsonObject.serializer(), request)
        synchronized(h.lock) {
            h.writer.write(line); h.writer.newLine(); h.writer.flush()
        }
        val response = h.awaitResponse(id, timeoutSeconds)
        if (response.containsKey("error")) {
            val err = response["error"] as? JsonObject
            val code = (err?.get("code") as? JsonPrimitive)?.content
            val message = (err?.get("message") as? JsonPrimitive)?.content
            throw RuntimeException("mcp error $code: $message")
        }
        return response["result"] ?: JsonPrimitive("null")
    }

    /** Start a stdio-based MCP server. */
    fun start(serverId: String, spec: McpLaunchSpec) {
        specs[serverId] = spec
        restartAttempts.remove(serverId)
        val existing = procs[serverId]
        if (existing != null && !existing.process.isAlive) {
            procs.remove(serverId); existing.close()
        }
        if (!procs.containsKey(serverId)) {
            procs[serverId] = launch(spec)
        }
    }

    /** Start a remote MCP server (SSE or Streamable HTTP). */
    fun startRemote(
        serverId: String,
        url: String,
        transport: Transport,
        headers: Map<String, String> = emptyMap(),
    ) {
        sseClients.remove(serverId)?.disconnect()
        val client = McpSseClient(serverId, url, transport, headers)
        client.connect()
        sseClients[serverId] = client
    }

    fun stop(serverId: String) {
        specs.remove(serverId); restartAttempts.remove(serverId)
        procs.remove(serverId)?.close()
        sseClients.remove(serverId)?.disconnect()
    }

    fun isRunning(serverId: String): Boolean =
        procs[serverId]?.process?.isAlive == true || sseClients[serverId]?.isConnected == true

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
            result[id] = HealthStatus(alive = client.isConnected, restartAttempts = 0, serverId = id)
        }
        return result
    }

    data class HealthStatus(val alive: Boolean, val restartAttempts: Int, val serverId: String)

    private fun runHealthChecks() {
        for ((serverId, handle) in procs) {
            if (!handle.process.isAlive) {
                val attempts = restartAttempts.computeIfAbsent(serverId) { AtomicInteger(0) }
                if (attempts.get() < maxRestartAttempts) {
                    val attempt = attempts.incrementAndGet()
                    log.warn("[MCP Health] {} is dead, auto-restart attempt {}/{}", serverId, attempt, maxRestartAttempts)
                    try {
                        val spec = specs[serverId] ?: continue
                        handle.close()
                        val newHandle = launch(spec)
                        procs[serverId] = newHandle
                        Thread.sleep(1000)
                        if (newHandle.process.isAlive) {
                            attempts.set(0)
                            log.info("[MCP Health] {} restarted successfully", serverId)
                        }
                    } catch (e: Exception) {
                        log.warn("[MCP Health] Failed to restart {}: {}", serverId, e.message)
                    }
                } else {
                    log.warn("[MCP Health] {} exceeded max restart attempts, giving up", serverId)
                }
            }
        }
    }

    fun ping(serverId: String): Boolean = try {
        if (!isRunning(serverId)) false
        else call(serverId, "ping").let { true }
    } catch (e: Exception) { false }

    private fun launch(spec: McpLaunchSpec): Handle {
        val resolvedArgv = resolveArgv(spec.argv)
        val pb = ProcessBuilder(resolvedArgv).redirectErrorStream(false)
        spec.cwd?.let { pb.directory(java.io.File(it)) }
        val env = pb.environment()
        val extraDirs = collectSearchDirs()
        if (extraDirs.isNotEmpty()) {
            val extraPath = extraDirs.joinToString(":")
            val existing = env["PATH"] ?: ""
            env["PATH"] = if (existing.isNotEmpty()) "$extraPath:$existing" else extraPath
        }
        if (spec.env.isNotEmpty()) env.putAll(spec.env)
        val proc = try { pb.start() }
        catch (e: IOException) {
            throw IOException("Failed to start MCP '${spec.id}': ${e.message}. " +
                "Resolved argv=$resolvedArgv, PATH=${env["PATH"]?.take(200)}", e)
        }
        val writer = BufferedWriter(OutputStreamWriter(proc.outputStream, StandardCharsets.UTF_8))
        val handle = Handle(proc, writer)
        val readerThread = Thread({
            pumpStdout(handle, BufferedReader(InputStreamReader(proc.inputStream, StandardCharsets.UTF_8)))
        }, "mcp-stdout-${spec.id}")
        readerThread.isDaemon = true; readerThread.start()
        val errThread = Thread({ drain(proc.errorStream) }, "mcp-stderr-${spec.id}")
        errThread.isDaemon = true; errThread.start()
        return handle
    }

    private fun resolveArgv(argv: List<String>): List<String> {
        if (argv.isEmpty()) return argv
        val cmd = argv[0]
        if (cmd.startsWith("/")) return argv
        for (dir in collectSearchDirs()) {
            val candidate = java.io.File(dir, cmd)
            if (candidate.isFile && candidate.canExecute()) {
                return listOf(candidate.absolutePath) + argv.drop(1)
            }
        }
        return listOf("/usr/bin/env") + argv
    }

    @Volatile private var cachedSearchDirs: List<String>? = null

    private fun collectSearchDirs(): List<String> {
        cachedSearchDirs?.let { return it }
        val dirs = mutableListOf<String>()
        val shellPath = resolveShellPath()
        if (shellPath.isNotEmpty()) {
            dirs.addAll(shellPath.split(":").filter { it.isNotEmpty() })
        }
        val home = System.getProperty("user.home") ?: ""
        if (home.isNotEmpty()) {
            val nvmDir = System.getenv("NVM_DIR") ?: "$home/.nvm"
            val nvmVersions = java.io.File("$nvmDir/versions/node")
            if (nvmVersions.isDirectory) {
                nvmVersions.listFiles()?.filter { it.isDirectory }?.forEach { versionDir ->
                    val binDir = java.io.File(versionDir, "bin")
                    if (binDir.isDirectory) dirs.add(binDir.absolutePath)
                }
            }
            val fnmDir = java.io.File("$home/Library/fnm/node-versions")
            if (fnmDir.isDirectory) {
                fnmDir.listFiles()?.filter { it.isDirectory }?.forEach { versionDir ->
                    val binDir = java.io.File(versionDir, "installation/bin")
                    if (binDir.isDirectory) dirs.add(binDir.absolutePath)
                }
            }
            val voltaBin = "$home/.volta/bin"
            if (java.io.File(voltaBin).isDirectory) dirs.add(voltaBin)
            val nBin = "/usr/local/bin"
            if (java.io.File(nBin).isDirectory) dirs.add(nBin)
        }
        for (brewPrefix in listOf("/opt/homebrew", "/usr/local")) {
            val binDir = "$brewPrefix/bin"
            if (java.io.File(binDir).isDirectory) dirs.add(binDir)
        }
        cachedSearchDirs = dirs
        return dirs
    }

    @Volatile private var cachedShellPath: String? = null

    private fun resolveShellPath(): String {
        cachedShellPath?.let { return it }
        for (shell in listOf("/bin/zsh", "/bin/bash")) {
            try {
                val pb = ProcessBuilder(shell, "-l", "-c", "echo \$PATH")
                val proc = pb.start()
                val path = proc.inputStream.bufferedReader().readText().trim()
                proc.waitFor(5, TimeUnit.SECONDS)
                if (path.isNotEmpty() && path.contains("/")) {
                    cachedShellPath = path; return path
                }
            } catch (_: Exception) { }
        }
        return ""
    }

    private fun pumpStdout(handle: Handle, reader: BufferedReader) {
        reader.use { r ->
            while (handle.process.isAlive) {
                val line = try { r.readLine() ?: break } catch (_: Throwable) { break }
                if (line.isBlank()) continue
                val node = try { json.parseToJsonElement(line) as? JsonObject } catch (_: Throwable) { continue } ?: continue
                val idNode = node["id"] as? JsonPrimitive ?: continue
                val idInt = idNode.content.toIntOrNull() ?: continue
                handle.deliver(idInt, node)
            }
        }
    }

    private fun drain(stream: java.io.InputStream) {
        BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8)).use { r ->
            while (true) {
                val line = try { r.readLine() ?: break } catch (_: Throwable) { break }
                log.warn("[mcp-stderr] {}", line)
            }
        }
    }

    override fun close() {
        healthScheduler.shutdown()
        try { healthScheduler.awaitTermination(5, TimeUnit.SECONDS) } catch (_: InterruptedException) { }
        procs.values.forEach { it.close() }; procs.clear()
        sseClients.values.forEach { it.disconnect() }; sseClients.clear()
        specs.clear(); restartAttempts.clear()
    }

    data class McpLaunchSpec(
        val id: String,
        val argv: List<String>,
        val cwd: String? = null,
        val env: Map<String, String> = emptyMap(),
    )

    private class Handle(val process: Process, val writer: BufferedWriter) {
        val lock = Any()
        private val seq = AtomicInteger(1)
        private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonObject>>()
        private val dropped = ConcurrentLinkedQueue<JsonObject>()

        fun nextId(): Int = seq.getAndIncrement()

        fun deliver(id: Int, body: JsonObject) {
            val fut = pending.remove(id) ?: run { dropped.add(body); return }
            fut.complete(body)
        }

        fun awaitResponse(id: Int, timeoutSeconds: Long = 30): JsonObject {
            val fut = CompletableFuture<JsonObject>()
            pending[id] = fut
            return try {
                fut.get(timeoutSeconds, TimeUnit.SECONDS)
            } catch (t: Throwable) {
                pending.remove(id)
                throw RuntimeException("mcp await timeout for id $id", t)
            }
        }

        fun close() {
            runCatching { writer.close() }
            runCatching { process.destroy() }
            val p = process
            val killer = Thread({
                if (!p.waitFor(5, TimeUnit.SECONDS)) p.destroyForcibly()
            }, "mcp-kill-${process.pid()}")
            killer.isDaemon = true; killer.start()
        }
    }
}
