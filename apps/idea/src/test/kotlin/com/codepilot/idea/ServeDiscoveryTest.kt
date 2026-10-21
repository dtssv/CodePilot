package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class ServeDiscoveryTest {
    @Test
    fun `wsUrl appends token query`() {
        val info = ServeInfo(url = "ws://127.0.0.1:18765/rpc", token = "abc", pid = 1, host = "127.0.0.1", port = 18765)
        assertEquals("ws://127.0.0.1:18765/rpc?token=abc", ServeDiscovery.wsUrl(info))
    }

    @Test
    fun `wsUrl without token leaves url alone`() {
        val info = ServeInfo(url = "ws://127.0.0.1:9/rpc", token = "", pid = 1, host = "127.0.0.1", port = 9)
        assertEquals("ws://127.0.0.1:9/rpc", ServeDiscovery.wsUrl(info))
    }

    @Test
    fun `readLive returns null for missing lockfile`(@TempDir home: Path) {
        val prev = System.getProperty("user.home")
        try {
            System.setProperty("user.home", home.toString())
            assertNull(ServeDiscovery.readLive())
            // Dead pid must not look live.
            val dir = ServeDiscovery.codepilotDir()
            dir.mkdirs()
            dir.resolve("serve.json").writeText(
                """{"url":"ws://127.0.0.1:18765/rpc","token":"x","pid":999999999,"host":"127.0.0.1","port":18765,"startedAt":"2020-01-01T00:00:00.000Z"}""",
            )
            assertNull(ServeDiscovery.readLive())
        } finally {
            if (prev != null) System.setProperty("user.home", prev) else System.clearProperty("user.home")
        }
    }
}
