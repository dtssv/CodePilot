package com.codepilot.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [CodepilotService] helpers. Anything that touches the IntelliJ `Application`
 * / `Project` services is out of scope here (requires the IDE fixture) — see the commented
 * skeletons at the bottom for the intended coverage once the plugin adds a fixture-based suite.
 */
class CodepilotServiceTest {

    // ---------- buildCommand ----------

    @Test
    fun `buildCommand with defaults produces codepilot serve`() {
        val state = CodepilotSettings.State()
        assertEquals(listOf("codepilot", "serve"), CodepilotService.buildCommand(state))
    }

    @Test
    fun `buildCommand appends extra args split on whitespace`() {
        val state = CodepilotSettings.State(extraArgs = "--verbose  --model gpt-4o ")
        assertEquals(
            listOf("codepilot", "serve", "--verbose", "--model", "gpt-4o"),
            CodepilotService.buildCommand(state),
        )
    }

    @Test
    fun `buildCommand respects custom binary path`() {
        val state = CodepilotSettings.State(codepilotPath = "/usr/local/bin/codepilot")
        assertEquals(listOf("/usr/local/bin/codepilot", "serve"), CodepilotService.buildCommand(state))
    }

    // ---------- parseEnv ----------

    @Test
    fun `parseEnv parses KEY equals VALUE lines`() {
        val env = CodepilotService.parseEnv("ANTHROPIC_API_KEY=sk-123\nFOO=bar")
        assertEquals(mapOf("ANTHROPIC_API_KEY" to "sk-123", "FOO" to "bar"), env)
    }

    @Test
    fun `parseEnv skips blanks comments and malformed lines`() {
        val text = """
            # this is a comment

            KEY=value
            no-equals-sign
            =leading-equals
            SPACED =  value with spaces
        """.trimIndent()
        val env = CodepilotService.parseEnv(text)
        assertEquals(
            mapOf("KEY" to "value", "SPACED" to "value with spaces"),
            env,
        )
    }

    @Test
    fun `parseEnv returns empty map for empty input`() {
        assertTrue(CodepilotService.parseEnv("").isEmpty())
        assertTrue(CodepilotService.parseEnv("\n\n  \n").isEmpty())
    }
}

/*
 * The following behaviors require the IntelliJ Platform test fixture (BasePlatformTestCase) and
 * are intentionally not unit-tested here:
 *
 *  - CodepilotService.Application.client() lazily starting the process and caching the instance.
 *  - CodepilotService.Application.dispose() shutting the client down.
 *  - ProjectService.newSessionId() reading project.basePath and forwarding settings.
 *
 * A fixture-based suite should live under src/test/kotlin with the `intellijPlatform` test
 * framework on the classpath; enable it once the plugin adds an integration-test source set.
 */
