package com.codepilot.idea

import com.intellij.openapi.diagnostic.logger
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Shared-daemon LineEngine: attach to `~/.codepilot/serve.json` over WebSocket,
 * or spawn the bundled / PATH `codepilot serve --daemon` and then attach.
 *
 * Falls back to [EngineProcess] stdio when [engineMode] is `"stdio"`.
 */
class SharedEngineProcess(
    private val daemonCommand: () -> List<String>,
    private val stdioCommand: () -> List<String>,
    private val workingDir: () -> String,
    private val env: () -> Map<String, String> = { emptyMap() },
    private val engineMode: () -> String = { "shared" },
    private val onLine: (String) -> Unit,
    private val onExit: (String) -> Unit,
    private val onStderr: (String) -> Unit = {},
) : LineEngine {
    private val log = logger<SharedEngineProcess>()
    private var stdio: EngineProcess? = null
    private var ws: WebSocket? = null
    private var ownedDaemon: Process? = null
    private val pending = CopyOnWriteArrayList<String>()
    @Volatile private var connecting = false

    override val running: Boolean
        @Synchronized get() = connecting || ws != null || (stdio?.running == true)

    @Synchronized
    override fun start() {
        if (running) return
        if (engineMode() == "stdio") {
            val e = EngineProcess(stdioCommand, workingDir, env, onLine, onExit, onStderr)
            stdio = e
            e.start()
            return
        }
        connecting = true
        Thread({
            try {
                var info = ServeDiscovery.readLive()
                if (info == null) {
                    ownedDaemon = spawnDaemon()
                    info = ServeDiscovery.waitLive(15_000)
                        ?: throw IllegalStateException(
                            "daemon did not publish ~/.codepilot/serve.json after starting `${daemonCommand().joinToString(" ")}`",
                        )
                }
                connectWs(info)
            } catch (e: Exception) {
                connecting = false
                onExit(e.message ?: e.toString())
            }
        }, "codepilot-shared-engine").apply { isDaemon = true }.start()
    }

    @Synchronized
    override fun write(line: String) {
        val payload = line.trimEnd('\n')
        stdio?.let {
            it.write(payload)
            return
        }
        val socket = ws
        if (socket != null && !connecting) {
            socket.sendText(payload, true)
            return
        }
        if (connecting || socket != null) {
            pending.add(payload)
            return
        }
        throw IllegalStateException("engine is not running")
    }

    override fun stop() {
        connecting = false
        pending.clear()
        stdio?.stop()
        stdio = null
        val socket = synchronized(this) { ws.also { ws = null } }
        socket?.let { runCatching { it.sendClose(WebSocket.NORMAL_CLOSURE, "stop") } }
        // Do not kill ownedDaemon — other clients may share it; idle grace exits it.
        ownedDaemon = null
        onExit("engine stopped")
    }

    private fun spawnDaemon(): Process {
        val cmd = daemonCommand()
        val pb = ProcessBuilder(cmd).directory(File(workingDir()))
        pb.environment().putAll(env())
        pb.redirectErrorStream(false)
        val p = try {
            pb.start()
        } catch (e: Exception) {
            throw IllegalStateException("could not start `${cmd.firstOrNull()}`: ${e.message}", e)
        }
        Thread({
            p.errorStream.bufferedReader().useLines { lines ->
                lines.forEach { onStderr(it) }
            }
        }, "codepilot-daemon-err").apply { isDaemon = true }.start()
        return p
    }

    private fun connectWs(info: ServeInfo) {
        val url = ServeDiscovery.wsUrl(info)
        val client = HttpClient.newHttpClient()
        val listener = object : WebSocket.Listener {
            private val buf = StringBuilder()

            override fun onOpen(webSocket: WebSocket) {
                synchronized(this@SharedEngineProcess) {
                    ws = webSocket
                    connecting = false
                    val queued = pending.toList()
                    pending.clear()
                    queued.forEach { webSocket.sendText(it, true) }
                }
                webSocket.request(1)
            }

            override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
                buf.append(data)
                if (last) {
                    val text = buf.toString()
                    buf.clear()
                    for (line in text.split('\n')) {
                        if (line.isNotBlank()) onLine(line.trim())
                    }
                }
                webSocket.request(1)
                return CompletableFuture.completedFuture(null)
            }

            override fun onBinary(webSocket: WebSocket, data: ByteBuffer, last: Boolean): CompletionStage<*> {
                webSocket.request(1)
                return CompletableFuture.completedFuture(null)
            }

            override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String?): CompletionStage<*> {
                synchronized(this@SharedEngineProcess) {
                    if (ws === webSocket) ws = null
                    connecting = false
                }
                onExit("engine websocket closed")
                return CompletableFuture.completedFuture(null)
            }

            override fun onError(webSocket: WebSocket, error: Throwable) {
                log.warn("codepilot websocket: ${error.message}")
                synchronized(this@SharedEngineProcess) {
                    if (ws === webSocket) ws = null
                    connecting = false
                }
                onExit("websocket error: ${error.message}")
            }
        }
        client.newWebSocketBuilder().buildAsync(URI.create(url), listener).join()
    }
}
