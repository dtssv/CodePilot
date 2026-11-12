package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for the inline-completion client-cache key and the
 * workspace-relative path resolution. These are the two behaviours behind the
 * "backspace/retype is free" and "path carries directories" guarantees; the
 * IntelliJ-coupled provider itself needs a platform fixture and is out of scope.
 */
class CompletionKeysTest {

    // ---------- cache key stability ----------

    @Test
    fun `same context yields the same key (backspace-retype hits the cache)`() {
        val a = CompletionKeys.cacheKey("src/a.kt", "fun foo() {\n    return ", "\n}")
        val b = CompletionKeys.cacheKey("src/a.kt", "fun foo() {\n    return ", "\n}")
        assertEquals(a, b)
    }

    @Test
    fun `a different prefix yields a different key`() {
        val a = CompletionKeys.cacheKey("src/a.kt", "val x = ", "")
        val b = CompletionKeys.cacheKey("src/a.kt", "val y = ", "")
        assertNotEquals(a, b)
    }

    @Test
    fun `a different path yields a different key`() {
        val a = CompletionKeys.cacheKey("src/a.kt", "val x = ", "")
        val b = CompletionKeys.cacheKey("src/b.kt", "val x = ", "")
        assertNotEquals(a, b)
    }

    @Test
    fun `only the prefix tail and suffix head matter for the key`() {
        // The two prefixes share an identical last-512-char window but differ
        // only in the far head (beyond the window) → same key.
        val sharedTail = "z".repeat(512)
        val a = CompletionKeys.cacheKey("p", "AAAA$sharedTail", "")
        val b = CompletionKeys.cacheKey("p", "BBBBBBBB$sharedTail", "")
        assertEquals(a, b)
    }

    // ---------- relative path ----------

    @Test
    fun `relativePath strips the project base and keeps directories`() {
        assertEquals(
            "src/main/App.kt",
            CompletionKeys.relativePath("/home/me/proj/src/main/App.kt", "/home/me/proj"),
        )
    }

    @Test
    fun `relativePath tolerates a trailing slash on the base`() {
        assertEquals(
            "a/b.kt",
            CompletionKeys.relativePath("/root/a/b.kt", "/root/"),
        )
    }

    @Test
    fun `relativePath is null outside the project (caller falls back)`() {
        assertNull(CompletionKeys.relativePath("/elsewhere/x.kt", "/root"))
        assertNull(CompletionKeys.relativePath(null, "/root"))
        assertNull(CompletionKeys.relativePath("/root/x.kt", null))
    }
}
