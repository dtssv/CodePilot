package io.codepilot.plugin.completion

import io.codepilot.plugin.settings.CodePilotSettings

/** Shared gates for inline / CodePilot Tab completion. */
object TabCompletionSupport {
    private const val MIN_LINE_PREFIX = 3
    private const val DEBOUNCE_MS = 120L

    fun isEnabled(): Boolean {
        val settings = CodePilotSettings.getInstance().state
        if (settings.privacyMode) return false
        val s = CodePilotSettings.getInstance()
        return !s.accessToken().isNullOrBlank() || settings.devToken.isNotBlank()
    }

    fun debounceMs(): Long = DEBOUNCE_MS

    fun hasEnoughPrefix(prefix: String): Boolean {
        val lastLine = prefix.substringAfterLast('\n', prefix)
        return lastLine.trimStart().length >= MIN_LINE_PREFIX
    }
}
