package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runs `cat` as a stand-in engine: every line written comes straight back. */
class EngineProcessTest {

    private val lines = CopyOnWriteArrayList<String>()
    private val exits = CopyOnWriteArrayList<String>()

    private fun engine(cmd: List<String> = listOf("cat"), onLine: (String) -> Unit = { lines += it }) = EngineProcess(
        command = { cmd },
        workingDir = { System.getProperty("java.io.tmpdir") },
        onLine = onLine,
        onExit = { exits += it },
    )

    @Test
    fun `relays lines and stops once`() {
        val got = CountDownLatch(2)
        val e = engine { lines += it; got.countDown() }
        e.start()
        e.start()
        assertTrue(e.running)
        e.write("""{"id":1}""")
        e.write("{\"id\":2}\n")
        assertTrue(got.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("""{"id":1}""", """{"id":2}"""), lines)

        e.stop()
        e.stop()
        assertFalse(e.running)
        Thread.sleep(200)
        assertEquals(listOf("engine stopped"), exits)
        assertThrows<IllegalStateException> { e.write("x") }
    }

    @Test
    fun `reports when the process exits by itself`() {
        val e = engine(listOf("sh", "-c", "echo hello; exit 3"))
        e.start()
        val deadline = System.currentTimeMillis() + 5000
        while (exits.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20)
        assertEquals(listOf("hello"), lines)
        assertEquals(listOf("engine exited (code=3)"), exits)
        assertFalse(e.running)
    }

    @Test
    fun `start failures name the command`() {
        val e = engine(listOf("/definitely/not/codepilot", "serve"))
        val err = assertThrows<IllegalStateException> { e.start() }
        assertTrue(err.message!!.contains("/definitely/not/codepilot"))
        assertFalse(e.running)
    }
}
