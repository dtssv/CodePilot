package com.codepilot.idea

import com.google.gson.Gson
import com.google.gson.JsonObject

/**
 * In-process fake of the `codepilot serve` NDJSON JSON-RPC server.
 *
 * The client under test spawns a real *process* — so this helper materializes a small Python
 * program (plus a shell wrapper) into a temp directory. The Python script is fully pre-programmed
 * by the JVM test before the client starts: a mapping of `method → response template` plus an
 * optional list of raw lines to emit after the `initialize` handshake. This keeps the wire format
 * identical to the real server (chunked NDJSON over stdout) while avoiding any runtime JVM⇄Python
 * IPC beyond stdin/stdout.
 */
object FakeCodepilotServer {

    /**
     * Declarative server behavior.
     *
     * @param responder maps an incoming request (`method`, `params`) to either a `result` object
     *   (`ok { ... }`) or an error (`error(code, message)`). Returning `null` yields a
     *   JSON-RPC `-32601 Method not found` error.
     * @param afterInitialize raw NDJSON lines written to stdout immediately after the
     *   `initialize` response (e.g. a `permission/request` reverse-request frame).
     * @param delaysMs per-method artificial delay before the response is written — used to
     *   exercise client-side timeouts.
     * @param chunkSize when > 0, every NDJSON line is split into ≤ `chunkSize`-byte writes so the
     *   client must reassemble partial lines.
     * @param chunkDelayMs delay between chunks (only meaningful when [chunkSize] > 0).
     */
    class Behavior(
        /**
         * Maps an incoming request to a `result` payload, an [ErrorFrame] sentinel, or `null`
         * (→ JSON-RPC `-32601 Method not found`).
         */
        val responder: (method: String, params: JsonObject) -> Any?,
        val afterInitialize: List<String> = emptyList(),
        /** Raw NDJSON lines emitted after each `prompt/send` notification (keyed by sessionId → lines). */
        val afterPrompt: Map<String, List<String>> = emptyMap(),
        val delaysMs: Map<String, Long> = emptyMap(),
        val chunkSize: Int = 0,
        val chunkDelayMs: Long = 0,
    )

    /**
     * Sentinel a [Behavior.responder] can return to make the server reply with a JSON-RPC *error*
     * frame instead of a `result`. Usage: `return errorFrame(-32602, "Invalid params")`.
     */
    class ErrorFrame(val code: Int, val message: String)

    /**
     * Build an [ErrorFrame] sentinel. The responder's return type is `JsonObject?`, so callers must
     * use the `responderOrError` wrapper or cast — see [CodepilotClientTest] for examples.
     */
    fun errorFrame(code: Int, message: String): ErrorFrame = ErrorFrame(code, message)

    data class Installed(val command: List<String>, val workingDir: java.io.File)

    private val gson = Gson()

    /** Materialize the fake server into a fresh temp dir; return the command + cwd for the client. */
    fun install(behavior: Behavior): Installed {
        val dir = java.nio.file.Files.createTempDirectory("fake-codepilot").toFile()
        dir.deleteOnExit()

        // Serialize the behavior into a JSON "program" the Python script consumes.
        val program = JsonObject().apply {
            addProperty("chunkSize", behavior.chunkSize)
            addProperty("chunkDelayMs", behavior.chunkDelayMs)
            val delays = JsonObject()
            behavior.delaysMs.forEach { (m, d) -> delays.addProperty(m, d) }
            add("delays", delays)
            val init = com.google.gson.JsonArray()
            behavior.afterInitialize.forEach { init.add(it) }
            add("afterInitialize", init)
            val afterPrompt = JsonObject()
            behavior.afterPrompt.forEach { (sid, lines) ->
                val arr = com.google.gson.JsonArray()
                lines.forEach { arr.add(it) }
                afterPrompt.add(sid, arr)
            }
            add("afterPrompt", afterPrompt)
        }
        java.io.File(dir, "program.json").writeText(gson.toJson(program))

        // The Python interpreter reads stdin frames and consults the pre-programmed table.
        // Request dispatch is delegated back to the JVM through a tiny file exchange because the
        // responder is arbitrary Kotlin code; see BRIDGE_PROTOCOL below.
        java.io.File(dir, "fake_server.py").writeText(PYTHON_SCRIPT)

        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        val command: List<String> = if (isWindows) {
            val bat = java.io.File(dir, "fake_server.cmd")
            bat.writeText("@echo off\r\npython \"%~dp0fake_server.py\" %*\r\n")
            listOf(bat.absolutePath)
        } else {
            val sh = java.io.File(dir, "fake_server.sh")
            sh.writeText("#!/bin/sh\nexec python3 \"\$(dirname \"\$0\")/fake_server.py\" \"\$@\"\n")
            sh.setExecutable(true)
            listOf(sh.absolutePath)
        }

        return Installed(command, dir)
    }

    /**
     * Start the JVM half of the bridge. Must be called before [CodepilotClient.start]; the returned
     * [Bridge] should be [Bridge.stop]ped after the test.
     */
    fun startBridge(installed: Installed, behavior: Behavior): Bridge {
        val bridge = Bridge(installed.workingDir, behavior)
        val thread = Thread(bridge, "fake-codepilot-bridge").apply { isDaemon = true; start() }
        bridge.thread = thread
        return bridge
    }

    // ---------- JVM ⇄ Python bridge ----------

    /**
     * BRIDGE_PROTOCOL
     *   Python → JVM : writes the incoming frame (one line of JSON) into `req.txt`, then polls for
     *                  `resp.txt`.
     *   JVM → Python : this class polls for `req.txt`, invokes [Behavior.responder], writes the
     *                  resulting response frame (plus any configured delay) into `resp.txt`.
     *
     * The files are tiny, the exchange is strictly request/response, and the child deletes
     * `resp.txt` after reading — so no locking is required beyond the JVM-side create/delete.
     */
    class Bridge(private val dir: java.io.File, private val behavior: Behavior) : Runnable {
        @Volatile private var running = true
        internal lateinit var thread: Thread
        private val gson = Gson()
        private val reqFile = java.io.File(dir, "req.txt")
        private val respFile = java.io.File(dir, "resp.txt")

        fun stop() {
            running = false
            if (::thread.isInitialized) thread.join(3_000)
        }

        override fun run() {
            while (running) {
                try {
                    if (reqFile.exists() && reqFile.length() > 0) {
                        // Settle briefly so the child has finished writing.
                        Thread.sleep(10)
                        val line = reqFile.readText().trim()
                        reqFile.delete()
                        if (line.isNotEmpty()) {
                            handleFrame(line)
                        }
                    } else {
                        Thread.sleep(2)
                    }
                } catch (_: InterruptedException) {
                    return
                } catch (_: Throwable) {
                    // Malformed req.txt — ignore and keep polling.
                    Thread.sleep(10)
                }
            }
        }

        private fun handleFrame(line: String) {
            val req = com.google.gson.JsonParser.parseString(line).asJsonObject
            val method = req.get("method")?.asString ?: ""
            val params = req.getAsJsonObject("params") ?: JsonObject()
            val id = if (req.has("id")) req.get("id").asLong else 0L

            val delay = behavior.delaysMs[method] ?: 0L
            val result = runCatching { behavior.responder(method, params) }.getOrNull()

            val frame = JsonObject().apply {
                addProperty("id", id)
                when {
                    result is ErrorFrame -> add("error", JsonObject().apply {
                        addProperty("code", result.code)
                        addProperty("message", result.message)
                    })
                    result is JsonObject -> add("result", result)
                    result == null -> add("error", JsonObject().apply {
                        addProperty("code", -32601)
                        addProperty("message", "method not found: $method")
                    })
                    else -> add("error", JsonObject().apply {
                        addProperty("code", -32603)
                        addProperty("message", "unsupported responder result: ${result.javaClass.name}")
                    })
                }
            }
            val payload = JsonObject().apply {
                addProperty("delayMs", delay)
                addProperty("frame", gson.toJson(frame))
            }
            respFile.writeText(gson.toJson(payload))
        }
    }

    // ---------- Python server script ----------

    private val PYTHON_SCRIPT = """
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REQ = os.path.join(HERE, "req.txt")
RESP = os.path.join(HERE, "resp.txt")
PROGRAM = os.path.join(HERE, "program.json")

with open(PROGRAM) as f:
    PROG = json.load(f)

CHUNK = int(PROG.get("chunkSize", 0))
CHUNK_DELAY_MS = int(PROG.get("chunkDelayMs", 0))
INIT_LINES = PROG.get("afterInitialize", [])
AFTER_PROMPT = PROG.get("afterPrompt", {})

out = sys.stdout

def emit(obj):
    line = json.dumps(obj)
    if CHUNK > 0:
        data = line.encode("utf-8")
        for i in range(0, len(data), CHUNK):
            out.write(data[i:i + CHUNK].decode("utf-8"))
            out.flush()
            if CHUNK_DELAY_MS:
                time.sleep(CHUNK_DELAY_MS / 1000.0)
        out.write("\n")
        out.flush()
    else:
        out.write(line + "\n")
        out.flush()

def emit_raw(line):
    out.write(line + "\n")
    out.flush()

def call_jvm(frame):
    with open(REQ, "w") as f:
        f.write(json.dumps(frame))
    deadline = time.time() + 30.0
    while time.time() < deadline:
        if os.path.exists(RESP) and os.path.getsize(RESP) > 0:
            time.sleep(0.01)
            with open(RESP) as f:
                payload = json.load(f)
            os.remove(RESP)
            delay = float(payload.get("delayMs", 0)) / 1000.0
            if delay > 0:
                time.sleep(delay)
            return json.loads(payload["frame"])
        time.sleep(0.002)
    return {"id": frame.get("id", 0), "error": {"code": -32000, "message": "JVM bridge timeout"}}

def main():
    # 1. Handshake: first line must be `initialize`.
    line = sys.stdin.readline()
    if not line:
        return
    frame = json.loads(line)
    resp = call_jvm(frame)
    emit(resp)

    # 2. Optional post-initialize script (raw NDJSON lines).
    for raw in INIT_LINES:
        if raw.strip():
            emit_raw(raw)

    # 3. Main dispatch loop.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except ValueError:
            emit({"id": 0, "error": {"code": -32700, "message": "parse error"}})
            continue
        resp = call_jvm(frame)
        # Notifications (no id) get no response frame.
        if "id" in frame:
            emit(resp)
        # After a prompt/send notification, push any scripted per-session events.
        if frame.get("method") == "prompt/send":
            sid = (frame.get("params") or {}).get("sessionId")
            for raw in AFTER_PROMPT.get(sid, []):
                if raw.strip():
                    emit_raw(raw)

if __name__ == "__main__":
    main()
""".trimIndent()
}
