package com.codepilot.idea

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files

class HostRelayTest {

    private class FakeEngine : LineEngine {
        override var running = false
        var starts = 0
        var stops = 0
        var failWith: String? = null
        val written = mutableListOf<String>()
        override fun start() {
            failWith?.let { throw IllegalStateException(it) }
            running = true
            starts++
        }
        override fun write(line: String) {
            check(running) { "engine is not running" }
            written += line
        }
        override fun stop() {
            running = false
            stops++
        }
    }

    private val delivered = mutableListOf<JsonObject>()
    private val opened = mutableListOf<Pair<String, Int?>>()
    private val engine = FakeEngine()
    private val relay = HostRelay(
        deliver = { delivered += JsonParser.parseString(it).asJsonObject },
        init = { HostInit(cwd = "/work", theme = "light", locale = "zh") },
        openFile = { p, l -> opened += p to l },
    ).also { it.engine = engine }

    private fun types() = delivered.map { it["type"].asString }

    @Test
    fun `ready sends init then starts the engine`() {
        relay.fromPage("""{"type":"ready"}""")
        assertEquals(listOf("host/init", "host/engine", "host/engine"), types())
        val init = delivered[0]
        assertEquals("/work", init["cwd"].asString)
        assertEquals("light", init["theme"].asString)
        assertEquals("idea", init["surface"].asString)
        assertEquals("ready", delivered[2]["state"].asString)
        assertEquals(1, engine.starts)
    }

    @Test
    fun `a reloaded page does not respawn the engine`() {
        relay.fromPage("""{"type":"ready"}""")
        relay.pageGone()
        relay.fromPage("""{"type":"ready"}""")
        assertEquals(1, engine.starts)
    }

    @Test
    fun `relays rpc lines both ways`() {
        relay.fromPage("""{"type":"ready"}""")
        relay.fromPage("""{"type":"rpc","line":"{\"id\":1}"}""")
        assertEquals(listOf("""{"id":1}"""), engine.written)
        relay.fromEngine("""{"id":1,"result":{}}""")
        assertEquals("rpc", delivered.last()["type"].asString)
        assertEquals("""{"id":1,"result":{}}""", delivered.last()["line"].asString)
    }

    @Test
    fun `queues host messages until ready and drops engine output`() {
        relay.prompt("explain", send = false)
        relay.fromEngine("""{"late":true}""")
        assertTrue(delivered.isEmpty())
        relay.fromPage("""{"type":"ready"}""")
        assertEquals(listOf("host/init", "host/prompt", "host/engine", "host/engine"), types())
        assertEquals("explain", delivered[1]["text"].asString)
    }

    @Test
    fun `reports start failures and exits`() {
        engine.failWith = "could not start `codepilot`"
        relay.fromPage("""{"type":"ready"}""")
        assertEquals("stopped", delivered.last()["state"].asString)
        assertEquals("could not start `codepilot`", delivered.last()["error"].asString)

        engine.failWith = null
        relay.fromPage("""{"type":"restart"}""")
        assertEquals("ready", delivered.last()["state"].asString)
        relay.engineExited("engine exited (code=1)")
        assertEquals("engine exited (code=1)", delivered.last()["error"].asString)
    }

    @Test
    fun `writing to a dead engine reports it stopped`() {
        relay.fromPage("""{"type":"ready"}""")
        engine.running = false
        relay.fromPage("""{"type":"rpc","line":"{}"}""")
        assertEquals("stopped", delivered.last()["state"].asString)
    }

    @Test
    fun `openFile and garbage`() {
        relay.fromPage("""{"type":"openFile","path":"src/a.kt","line":3}""")
        relay.fromPage("""{"type":"openFile","path":"b.md"}""")
        relay.fromPage("not json")
        relay.fromPage("""["array"]""")
        assertEquals(listOf("src/a.kt" to 3, "b.md" to null), opened)
    }

    @Test
    fun `withPreset injects before the app scripts`() {
        val out = withPreset("<html><head><title>x</title></head></html>", "dark")
        assertTrue(out.startsWith("<html><head><script>window.__codepilotHost={kind:\"idea\",theme:\"dark\"}</script><title>"))
    }

    @Test
    fun `resolveExecutable searches PATH for bare names`() {
        val dir = Files.createTempDirectory("cp-path").toFile()
        val exe = File(dir, "codepilot").apply { writeText("#!/bin/sh\n"); setExecutable(true) }
        val path = listOf("/nonexistent", dir.path).joinToString(File.pathSeparator)
        assertEquals(exe.path, resolveExecutable("codepilot", path))
        assertEquals("/abs/codepilot", resolveExecutable("/abs/codepilot", path))
        assertEquals("missing", resolveExecutable("missing", path))
        assertEquals("codepilot", resolveExecutable("codepilot", null))
    }
}
