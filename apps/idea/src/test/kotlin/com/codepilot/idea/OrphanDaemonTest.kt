package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class OrphanDaemonTest {
    @Test
    fun shellQuoteUnixEscapesEmbeddedQuotes() {
        assertEquals("'a'", OrphanDaemon.shellQuoteUnix("a"))
        assertEquals("'a b'", OrphanDaemon.shellQuoteUnix("a b"))
        assertEquals("'it'\\''s'", OrphanDaemon.shellQuoteUnix("it's"))
    }

    @Test
    fun unixLaunchUsesShBackground() {
        val launch =
            OrphanDaemon.buildLaunch(
                listOf("/usr/bin/codepilot", "serve", "--daemon", "--port", "18765"),
                windows = false,
            )
        assertEquals("/bin/sh", launch[0])
        assertEquals("-c", launch[1])
        assertEquals(
            "'/usr/bin/codepilot' 'serve' '--daemon' '--port' '18765' >/dev/null 2>&1 &",
            launch[2],
        )
    }

    @Test
    fun winLaunchUsesStartB() {
        val launch =
            OrphanDaemon.buildLaunch(
                listOf("codepilot", "serve", "--daemon"),
                windows = true,
                comSpec = "cmd.exe",
            )
        assertEquals("cmd.exe", launch[0])
        assertEquals("/d", launch[1])
        assertEquals("/s", launch[2])
        assertEquals("/c", launch[3])
        assertTrue(launch[4].startsWith("start \"\" /b "))
        assertTrue(launch[4].contains("codepilot serve --daemon"))
    }
}
