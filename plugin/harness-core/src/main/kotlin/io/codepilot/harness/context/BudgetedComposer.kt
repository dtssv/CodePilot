package io.codepilot.harness.context

import io.codepilot.harness.event.HarnessEvent

/**
 * Budget envelope for the whole prompt and per-section overrides.
 *
 * [totalChars] is a soft ceiling across all sections; when exceeded the
 * lowest-priority sections are truncated first.
 */
data class ContextBudget(
    val totalChars: Int = 80_000,
    val sectionOverrides: Map<String, Int> = emptyMap(),
)

/** What to do when a section exceeds its [PromptSection.maxChars] budget. */
enum class OverflowStrategy {
    /** Truncate the section to maxChars with a trailing marker. */
    TRUNCATE,
    /** Drop the whole section. */
    DROP,
    /** Compact via a [Compactor] (set the section's [PromptSection] to a CompactableSection). */
    COMPACT,
}

/**
 * Composes the system prompt from a list of [PromptSection]s under a [ContextBudget].
 *
 * Each section declares its own [PromptSection.maxChars]; the composer enforces it
 * using the section's [OverflowStrategy] (TRUNCATE by default). When the running
 * total exceeds [ContextBudget.totalChars], the remaining sections are skipped
 * (lowest priority = later in the list).
 *
 * This is the single entry point for prompt assembly — there is no hidden
 * collaboration between multiple prompt-builder classes (cf. the legacy
 * PromptBuilder + GraphPromptContextBudget + PhaseAwareMemoryLoader web).
 */
class BudgetedComposer(
    private val sections: List<PromptSection>,
    private val budget: ContextBudget = ContextBudget(),
    private val strategies: Map<String, OverflowStrategy> = emptyMap(),
) {
    fun compose(snapshot: List<HarnessEvent>): String {
        val sb = StringBuilder()
        var running = 0
        for (sec in sections) {
            val cap = budget.sectionOverrides[sec.name] ?: sec.maxChars
            val body = runCatching { sec.compose(snapshot) }.getOrDefault("")
            if (body.isBlank()) continue

            val remaining = budget.totalChars - running
            if (remaining <= 0) break
            val effectiveCap = minOf(cap, remaining)
            val strategy = strategies[sec.name] ?: OverflowStrategy.TRUNCATE

            val chunk = when (strategy) {
                OverflowStrategy.TRUNCATE -> truncate(body, effectiveCap)
                OverflowStrategy.DROP -> if (body.length <= effectiveCap) body else ""
                OverflowStrategy.COMPACT -> truncate(body, effectiveCap) // Compactor handles its own path
            }
            if (chunk.isNotBlank()) {
                sb.append("## ").append(sec.name).append('\n')
                sb.append(chunk).append("\n\n")
                running += chunk.length + sec.name.length + 5
            }
        }
        return sb.toString().trim()
    }

    private fun truncate(s: String, max: Int): String =
        if (s.length <= max) s
        else s.take(max) + "\n...[truncated ${s.length - max} chars]"
}
