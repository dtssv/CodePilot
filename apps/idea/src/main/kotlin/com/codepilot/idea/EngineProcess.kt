package com.codepilot.idea

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.Writer
import java.nio.charset.StandardCharsets

/**
 * The `codepilot serve` process behind one chat panel, as a line relay.
 *
 * The JCEF chat runs the shared web UI, which owns the JSON-RPC client; this
 * class only moves newline-delimited protocol lines between the process and
 * the page. Callbacks run on the process reader threads.
 */
class EngineProcess(
    private val command: () -> List<String>,
    private val workingDir: () -> String,
    private val env: () -> Map<String, String> = { emptyMap() },
    private val onLine: (String) -> Unit,
    private val onExit: (String) -> Unit,
    private val onStderr: (String) -> Unit = {},
) : LineEngine {
    private var process: Process? = null
    private var stdin: Writer? = null

    override val running: Boolean
        @Synchronized get() = process?.isAlive == true

 /** Spawn the process unless it is already running. Throws if it cannot start. */
    @Synchronized
    override fun start() {
        if (process?.isAlive == true) return
        val cmd = command()
        val pb = ProcessBuilder(cmd).directory(File(workingDir()))
        pb.environment().putAll(env())
        val p = try {
            pb.start()
        } catch (e: Exception) {
            throw IllegalStateException("could not start `${cmd.firstOrNull()}`: ${e.message}", e)
        }
        process = p
        stdin = OutputStreamWriter(p.outputStream, StandardCharsets.UTF_8)
        thread("codepilot-engine-out") {
            BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8)).useLines { lines ->
                lines.forEach { if (it.isNotBlank()) onLine(it.trim()) }
            }
            val code = runCatching { p.waitFor() }.getOrNull()
            if (detach(p)) onExit("engine exited (code=${code ?: "?"})")
        }
        thread("codepilot-engine-err") {
            BufferedReader(InputStreamReader(p.errorStream, StandardCharsets.UTF_8)).useLines { lines ->
                lines.forEach { onStderr(it) }
            }
        }
    }

    @Synchronized
    override fun write(line: String) {
        val w = stdin ?: throw IllegalStateException("engine is not running")
        w.write(line.trimEnd('\n'))
        w.write("\n")
        w.flush()
    }

    override fun stop() {
        val p = synchronized(this) { process } ?: return
        if (!detach(p)) return
        runCatching { p.outputStream.close() }
        p.destroy()
        onExit("engine stopped")
    }

 /** Forget [p] if it is still current; true when this call detached it. */
    @Synchronized
    private fun detach(p: Process): Boolean {
        if (process !== p) return false
        process = null
        stdin = null
        return true
    }

    private fun thread(name: String, body: () -> Unit) {
        Thread(body, name).apply { isDaemon = true }.start()
    }
}
