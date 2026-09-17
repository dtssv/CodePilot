package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [CodepilotSettings.State] and the [CodepilotSettings] state container.
 * The `Configurable` UI and `ApplicationManager`-backed singleton require the IDE fixture and are
 * out of scope here.
 */
class CodepilotSettingsTest {

    // ---------- defaults ----------

    @Test
    fun `default state matches documented defaults`() {
        val s = CodepilotSettings.State()
        assertEquals("codepilot", s.codepilotPath)
        assertEquals("", s.model)
        assertEquals("ask", s.permissionMode)
        assertEquals("agent", s.defaultMode)
        assertEquals("", s.extraArgs)
        assertEquals("", s.extraEnv)
    }

    // ---------- read/write roundtrip ----------

    @Test
    fun `state roundtrip through getState and loadState preserves all fields`() {
        val settings = CodepilotSettings()
        val original = CodepilotSettings.State(
            codepilotPath = "/opt/codepilot/bin/codepilot",
            model = "claude-3-7-sonnet",
            permissionMode = "auto-edit",
            defaultMode = "plan",
            extraArgs = "--verbose --timeout 30",
            extraEnv = "ANTHROPIC_API_KEY=sk-test\nFOO=bar",
        )

        settings.loadState(original)
        val readBack = settings.state

        assertEquals(original, readBack)
        assertEquals("/opt/codepilot/bin/codepilot", readBack.codepilotPath)
        assertEquals("claude-3-7-sonnet", readBack.model)
        assertEquals("auto-edit", readBack.permissionMode)
        assertEquals("plan", readBack.defaultMode)
        assertEquals("--verbose --timeout 30", readBack.extraArgs)
        assertEquals("ANTHROPIC_API_KEY=sk-test\nFOO=bar", readBack.extraEnv)
    }

    @Test
    fun `loadState replaces previous state rather than merging`() {
        val settings = CodepilotSettings()
        settings.loadState(CodepilotSettings.State(model = "first"))
        settings.loadState(CodepilotSettings.State(model = "second", permissionMode = "yolo"))

        assertEquals("second", settings.state.model)
        assertEquals("yolo", settings.state.permissionMode)
    }

    @Test
    fun `data class copy produces an independent instance`() {
        val a = CodepilotSettings.State(model = "m1")
        val b = a.copy(model = "m2")
        assertNotSame(a, b)
        assertEquals("m1", a.model)
        assertEquals("m2", b.model)
    }

    // ---------- normalizeMode ----------

    @Test
    fun `normalizeMode accepts the three valid modes`() {
        assertEquals("chat", CodepilotSettings.normalizeMode("chat"))
        assertEquals("plan", CodepilotSettings.normalizeMode("plan"))
        assertEquals("agent", CodepilotSettings.normalizeMode("agent"))
    }

    @Test
    fun `normalizeMode falls back to agent for unknown or null input`() {
        assertEquals("agent", CodepilotSettings.normalizeMode(null))
        assertEquals("agent", CodepilotSettings.normalizeMode(""))
        assertEquals("agent", CodepilotSettings.normalizeMode("CHAT")) // case-sensitive
        assertEquals("agent", CodepilotSettings.normalizeMode("ask"))
    }

    @Test
    fun `defaultModes list contains all valid modes`() {
        assertEquals(listOf("agent", "plan", "chat"), CodepilotSettings.defaultModes)
    }
}
