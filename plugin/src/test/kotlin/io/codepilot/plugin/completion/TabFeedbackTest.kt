package io.codepilot.plugin.completion

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Pure-Kotlin tests for the TabFeedback counter math. We instantiate the service
 * directly (it has no constructor dependencies) so we don't need an
 * Application/Project fixture.
 */
class TabFeedbackTest {
    private lateinit var feedback: TabFeedback

    @BeforeEach
    fun setUp() {
        feedback = TabFeedback()
        feedback.reset()
    }

    @Test
    fun zeroState() {
        val s = feedback.snapshot()
        assertThat(s["suggestCount"]).isEqualTo(0L)
        assertThat(s["acceptCount"]).isEqualTo(0L)
        assertThat(s["acceptRate"]).isEqualTo(0.0)
        assertThat(s["avgLatencyMs"]).isEqualTo(0L)
    }

    @Test
    fun acceptRateAndAvgLatency() {
        feedback.recordSuggest(null, "a.kt", 100, 10)
        feedback.recordSuggest(null, "a.kt", 200, 12)
        feedback.recordSuggest(null, "a.kt", 300, 8)
        feedback.recordAccept(null, "a.kt", 12)
        feedback.recordDismiss(null, "esc")

        val s = feedback.snapshot()
        assertThat(s["suggestCount"]).isEqualTo(3L)
        assertThat(s["acceptCount"]).isEqualTo(1L)
        assertThat(s["dismissCount"]).isEqualTo(1L)
        assertThat(s["avgLatencyMs"]).isEqualTo(200L) // (100+200+300)/3
        // 1/3 ≈ 0.3333
        assertThat(s["acceptRate"] as Double).isCloseTo(1.0 / 3.0, org.assertj.core.data.Offset.offset(1e-6))
    }

    @Test
    fun resetClearsEverything() {
        feedback.recordSuggest(null, "x", 50, 5)
        feedback.recordAccept(null, "x", 5)
        feedback.reset()
        assertThat(feedback.snapshot()["suggestCount"]).isEqualTo(0L)
        assertThat(feedback.snapshot()["acceptCount"]).isEqualTo(0L)
    }

    @Test
    fun negativeLatencyIsIgnoredForAverage() {
        feedback.recordSuggest(null, "y", 100, 1)
        feedback.recordSuggest(null, "y", -1, 1)
        assertThat(feedback.snapshot()["avgLatencyMs"]).isEqualTo(100L)
    }
}
