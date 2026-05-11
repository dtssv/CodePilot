package io.codepilot.plugin.tools

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.io.*
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.*
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Manages persistent terminal sessions for Agent mode.
 * Unlike ShellExecutor (one-shot), this maintains PTY-like sessions where:
 * - Environment variables persist across commands
 * - Working directory changes persist
 * - Shell history is maintained
 * - Output can be streamed back to the UI
 *
 * Each Agent conversation can bind to one terminal session.
 * Sessions are automatically cleaned up when the project closes.
 */
@Service(Service.Level.PROJECT)
class TerminalSessionManager(
    private val project: Project,
) : Disposable {
    private val log = Logger.getInstance(TerminalSessionManager::class.java)
    private val sessions = ConcurrentHashMap<String, TerminalSession>()

    data class CommandResult(
        val stdout: String,
        val exitCode: Int,
        val durationMs: Long,
        val sessionId: String,
    )

    /**
     * Execute a command in a persistent session.
     * Creates a new session if sessionId is null or doesn't exist.
     */
    fun execute(
        command: String,
        sessionId: String? = null,
        cwd: String? = null,
        timeoutMs: Long = 60_000,
        env: Map<String, String> = emptyMap(),
    ): CommandResult {
        val sid = sessionId ?: UUID.randomUUID().toString()
        val session =
            sessions.computeIfAbsent(sid) {
                createSession(cwd ?: project.basePath ?: ".", env)
            }
        return session.execute(command, timeoutMs)
    }

    /** Get or create a session, returning its ID. */
    fun getOrCreateSession(
        sessionId: String? = null,
        cwd: String? = null,
    ): String {
        val sid = sessionId ?: UUID.randomUUID().toString()
        sessions.computeIfAbsent(sid) {
            createSession(cwd ?: project.basePath ?: ".", emptyMap())
        }
        return sid
    }

    /** Get recent output from a session (for @terminal reference). */
    fun getRecentOutput(
        sessionId: String,
        maxChars: Int = 5000,
    ): String? = sessions[sessionId]?.getRecentOutput(maxChars)

    /** Get last output from any active session (for @terminal reference). */
    fun getLastOutput(
        project: Project,
        maxLines: Int = 100,
    ): String {
        val instance = getInstance(project)
        // Find the most recently used session
        val lastSession = instance.sessions.values.maxByOrNull { it.lastUsedAt }
        val output = lastSession?.getRecentOutput(maxLines * 200) ?: return ""
        return output.lines().takeLast(maxLines).joinToString("\n")
    }

    /** Close a specific session. */
    fun closeSession(sessionId: String) {
        sessions.remove(sessionId)?.close()
    }

    override fun dispose() {
        sessions.values.forEach { it.close() }
        sessions.clear()
    }

    private fun createSession(
        cwd: String,
        env: Map<String, String>,
    ): TerminalSession = TerminalSession(cwd, env)

    companion object {
        @JvmStatic
        fun getInstance(project: Project): TerminalSessionManager = project.service()
    }

    /**
     * A single persistent terminal session backed by a shell process.
     */
    inner class TerminalSession(
        cwd: String,
        env: Map<String, String>,
    ) {
        private val id = UUID.randomUUID().toString()
        private val process: Process
        private val writer: BufferedWriter
        private val outputBuffer = StringBuilder()
        private val outputLock = Object()
        private val readerThread: Thread
        private val alive = AtomicBoolean(true)

        @Volatile var lastUsedAt: Long = System.currentTimeMillis()

        // Marker used to detect command completion
        private val endMarker = "___CODEPILOT_CMD_DONE_${System.nanoTime()}___"

        init {
            val shell =
                if (SystemInfo.isWindows) {
                    listOf("powershell.exe", "-NoProfile", "-NoLogo")
                } else {
                    listOf("/bin/bash", "--norc", "--noprofile", "-i")
                }

            val pb = ProcessBuilder(shell)
            pb.directory(File(cwd))
            pb.redirectErrorStream(true)
            pb.environment().putAll(env)
            // Set PS1 to empty for cleaner output parsing
            if (!SystemInfo.isWindows) {
                pb.environment()["PS1"] = ""
                pb.environment()["PS2"] = ""
            }

            process = pb.start()
            writer = BufferedWriter(OutputStreamWriter(process.outputStream, StandardCharsets.UTF_8))

            // Background reader thread
            readerThread =
                Thread({
                    val reader = BufferedReader(InputStreamReader(process.inputStream, StandardCharsets.UTF_8))
                    try {
                        val buffer = CharArray(4096)
                        while (alive.get()) {
                            val n = reader.read(buffer)
                            if (n == -1) break
                            synchronized(outputLock) {
                                outputBuffer.append(buffer, 0, n)
                                outputLock.notifyAll()
                            }
                        }
                    } catch (_: IOException) {
                    } finally {
                        alive.set(false)
                    }
                }, "CodePilot-Terminal-$id")
            readerThread.isDaemon = true
            readerThread.start()

            log.info("Terminal session created: $id in $cwd")
        }

        fun execute(
            command: String,
            timeoutMs: Long,
        ): CommandResult {
            if (!alive.get()) throw IllegalStateException("Terminal session is dead")

            lastUsedAt = System.currentTimeMillis()
            val startTime = System.currentTimeMillis()

            // Clear buffer and send command with end marker
            synchronized(outputLock) { outputBuffer.setLength(0) }

            val wrappedCommand =
                if (SystemInfo.isWindows) {
                    "$command; echo $endMarker `\$LASTEXITCODE`\r\n"
                } else {
                    "$command; echo \"$endMarker \$?\"\n"
                }

            writer.write(wrappedCommand)
            writer.flush()

            // Wait for end marker in output
            val deadline = startTime + timeoutMs
            var output = ""
            var exitCode = 0

            synchronized(outputLock) {
                while (System.currentTimeMillis() < deadline) {
                    val current = outputBuffer.toString()
                    val markerIdx = current.indexOf(endMarker)
                    if (markerIdx >= 0) {
                        output = current.substring(0, markerIdx).trim()
                        // Parse exit code from marker line
                        val afterMarker = current.substring(markerIdx + endMarker.length).trim()
                        exitCode = afterMarker.split(Regex("\\s+")).firstOrNull()?.toIntOrNull() ?: 0
                        break
                    }
                    outputLock.wait(100)
                }
            }

            val duration = System.currentTimeMillis() - startTime
            // Truncate output if too large
            val truncatedOutput = if (output.length > 64_000) output.take(64_000) + "\n... (truncated)" else output

            return CommandResult(
                stdout = truncatedOutput,
                exitCode = exitCode,
                durationMs = duration,
                sessionId = id,
            )
        }

        fun getRecentOutput(maxChars: Int): String {
            synchronized(outputLock) {
                return if (outputBuffer.length > maxChars) {
                    outputBuffer.substring(outputBuffer.length - maxChars)
                } else {
                    outputBuffer.toString()
                }
            }
        }

        fun close() {
            alive.set(false)
            try {
                writer.close()
            } catch (_: Exception) {
            }
            try {
                process.destroyForcibly()
            } catch (_: Exception) {
            }
            log.info("Terminal session closed: $id")
        }
    }
}
