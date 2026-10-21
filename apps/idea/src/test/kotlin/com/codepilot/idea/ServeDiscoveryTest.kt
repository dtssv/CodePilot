package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

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
    fun `readLive returns null for missing lockfile`() {
        // Best-effort: if the developer already has a live daemon this may
        // return non-null; we only assert the null path for a clearly dead pid.
        val dir = ServeDiscovery.codepilotDir()
        dir.mkdirs()
        val backup = dir.resolve("serve.json.bak-test")
        val serve = dir.resolve("serve.json")
        val server = dir.resolve("server.json")
        val hadServe = serve.isFile
        val hadServer = server.isFile
        try {
            if (hadServe) serve.copyTo(backup, overwrite = true)
            serve.writeText(
                """{"url":"ws://127.0.0.1:18765/rpc","token":"x","pid":999999999,"host":"127.0.0.1","port":18765,"startedAt":"2020-01-01T00:00:00.000Z"}""",
            )
            server.delete()
            assertNull(ServeDiscovery.readLive())
        } finally {
            if (hadServe) backup.copyTo(serve, overwrite = true) else serve.delete()
            backup.delete()
            if (!hadServer) server.delete()
        }
    }
}
