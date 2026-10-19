package com.codepilot.idea

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File

/** The engine as the relay sees it; [EngineProcess] in production. */
interface LineEngine {
    val running: Boolean
    fun start()
    fun write(line: String)
    fun stop()
}

/** Static facts sent to the page in `host/init`. */
data class HostInit(val cwd: String, val theme: String, val locale: String)

/**
 * The IDE side of the web UI's host bridge (apps/web/src/protocol/bridge.ts).
 *
 * page → IDE rpc {line} · ready · restart · openFile {path, line?}
 * IDE → page rpc {line} · host/init · host/engine · host/theme · host/prompt
 *
 * Messages for the page wait until it reports `ready`; that also (re)sends
 * `host/init`, so a reloaded page picks up where it left off.
 */
class HostRelay(
    private val deliver: (String) -> Unit,
    private val init: () -> HostInit,
    private val openFile: (path: String, line: Int?) -> Unit = { _, _ -> },
    private val onEngineError: (String) -> Unit = {},
) {
    lateinit var engine: LineEngine

    private val gson = Gson()
    private val queue = ArrayList<String>()
    private var pageReady = false

 /** A JSON message posted by the page. Malformed input is ignored. */
    fun fromPage(json: String) {
        val msg = runCatching { JsonParser.parseString(json).asJsonObject }.getOrNull() ?: return
        when (msg.str("type")) {
            "rpc" -> msg.str("line")?.let { line ->
                try {
                    engine.write(line)
                } catch (e: Exception) {
                    send(engineState("stopped", e.message))
                }
            }
            "ready" -> {
                val info = init()
                synchronized(this) { pageReady = true }
                send(obj("host/init") {
                    addProperty("cwd", info.cwd)
                    addProperty("theme", info.theme)
                    addProperty("locale", info.locale)
                    addProperty("surface", "idea")
                })
                flush()
                ensureEngine()
            }
            "restart" -> {
                engine.stop()
                ensureEngine()
            }
            "openFile" -> msg.str("path")?.let { path ->
                val line = msg.get("line")?.takeIf { it.isJsonPrimitive }?.asInt
                openFile(path, line)
            }
        }
    }

    fun fromEngine(line: String) = send(obj("rpc") { addProperty("line", line) }, keepUntilReady = false)

    fun engineExited(detail: String) = send(engineState("stopped", detail))

    fun theme(theme: String) = send(obj("host/theme") { addProperty("theme", theme) })

 /** Put [text] into the composer, or send it when [send] is true. */
    fun prompt(text: String, send: Boolean) = send(obj("host/prompt") {
        addProperty("text", text)
        addProperty("send", send)
    })

 /** The page was torn down (reload, dispose); hold messages until it is back. */
    @Synchronized
    fun pageGone() {
        pageReady = false
    }

    private fun ensureEngine() {
        if (!engine.running) {
            send(engineState("starting", null))
            try {
                engine.start()
            } catch (e: Exception) {
                val message = e.message ?: e.toString()
                onEngineError(message)
                send(engineState("stopped", message))
                return
            }
        }
        send(engineState("ready", null))
    }

 /** Engine output is dropped while the page is away: nobody would read the replies. */
    private fun send(json: String, keepUntilReady: Boolean = true) {
        synchronized(this) {
            if (!pageReady) {
                if (keepUntilReady) queue.add(json)
                return
            }
        }
        deliver(json)
    }

    private fun flush() {
        val pending = synchronized(this) { ArrayList(queue).also { queue.clear() } }
        pending.forEach(deliver)
    }

    private fun engineState(state: String, error: String?) = obj("host/engine") {
        addProperty("state", state)
        if (error != null) addProperty("error", error)
    }

    private fun obj(type: String, fill: JsonObject.() -> Unit): String =
        gson.toJson(JsonObject().apply { addProperty("type", type); fill() })

    private fun JsonObject.str(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive }?.asString
}

/** Tell the page it is in IntelliJ, with the IDE theme, before it boots. */
internal fun withPreset(html: String, theme: String): String {
    val preset = "<script>window.__codepilotHost={kind:\"idea\",theme:\"$theme\"}</script>"
    val at = html.indexOf("<head>")
    return if (at < 0) preset + html else html.substring(0, at + 6) + preset + html.substring(at + 6)
}

/** [name] if it is a path, else the first executable match on [path], else [name] unchanged. */
internal fun resolveExecutable(name: String, path: String?): String {
    if (name.contains(File.separatorChar) || path.isNullOrBlank()) return name
    val exts = if (File.separatorChar == '\\') listOf(".exe", ".cmd", ".bat", "") else listOf("")
    for (dir in path.split(File.pathSeparatorChar)) {
        for (ext in exts) {
            val f = File(dir, name + ext)
            if (f.isFile && f.canExecute()) return f.path
        }
    }
    return name
}
