package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Covers the Swing fallback's pure path helpers — the click-to-open support
 * added for the no-JCEF case. Rendering + navigation need the IDE platform, so
 * only the parse/linkify logic is unit-tested here.
 */
class ChatPanelTest {

    @Test
    fun `linkify wraps paths with a separator or extension`() {
        val out = ChatPanel.linkify("see src/main/App.kt and README.md for notes")
        assertTrue(out.contains("<a href='src/main/App.kt'"), out)
        assertTrue(out.contains("<a href='README.md'"), out)
    }

    @Test
    fun `linkify carries a trailing line and column`() {
        val out = ChatPanel.linkify("error at src/main/App.kt:42:7 here")
        assertTrue(out.contains("<a href='src/main/App.kt:42:7'"), out)
    }

    @Test
    fun `linkify leaves prose words alone`() {
        val out = ChatPanel.linkify("this is a plain sentence with no paths")
        assertFalse(out.contains("<a "), out)
    }

    @Test
    fun `parsePathLine splits a trailing line number`() {
        assertEquals("src/a.kt" to 42, ChatPanel.parsePathLine("src/a.kt:42"))
        assertEquals("src/a.kt" to 42, ChatPanel.parsePathLine("src/a.kt:42:7"))
    }

    @Test
    fun `parsePathLine keeps a bare path without a line`() {
        assertEquals("src/a.kt" to null, ChatPanel.parsePathLine("src/a.kt"))
        assertEquals("README.md" to null, ChatPanel.parsePathLine("README.md"))
    }

    @Test
    fun `parsePathLine preserves a Windows drive path`() {
        val (path, line) = ChatPanel.parsePathLine("""C:\src\a.kt:10""")
        assertEquals("""C:\src\a.kt""", path)
        assertEquals(10, line)
    }

    @Test
    fun `parsePathLine ignores a non-path colon suffix`() {
        // No separator and no extension on the head: treat the whole thing as a
        // path and do not peel off a line (avoids mangling words like "note:5").
        assertEquals("note:5" to null, ChatPanel.parsePathLine("note:5"))
    }
}
