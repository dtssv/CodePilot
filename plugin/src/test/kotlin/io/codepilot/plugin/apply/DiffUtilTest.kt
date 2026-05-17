package io.codepilot.plugin.apply

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Pure-Kotlin tests for [DiffUtil]. Independent of any IDE runtime.
 */
class DiffUtilTest {
    @Test
    fun emptyDiffWhenEqual() {
        assertThat(DiffUtil.diff("a\nb\nc", "a\nb\nc")).isEmpty()
    }

    @Test
    fun singleChangeProducesOneHunk() {
        val old = "a\nb\nc"
        val new = "a\nB\nc"
        val hunks = DiffUtil.diff(old, new)
        assertThat(hunks).hasSize(1)
        val h = hunks[0]
        assertThat(h.changes.any { it.kind == "del" && it.text == "b" }).isTrue
        assertThat(h.changes.any { it.kind == "add" && it.text == "B" }).isTrue
    }

    @Test
    fun applyAcceptedAllReproducesNew() {
        val old = "alpha\nbeta\ngamma\ndelta\nepsilon"
        val new = "alpha\nBETA\ngamma\nDELTA\nepsilon"
        val hunks = DiffUtil.diff(old, new)
        val rebuilt = DiffUtil.applyAccepted(old, hunks, hunks.map { it.id }.toSet())
        assertThat(rebuilt).isEqualTo(new)
    }

    @Test
    fun applyAcceptedNoneReproducesOld() {
        val old = "a\nb\nc\nd\ne"
        val new = "a\nX\nc\nY\ne"
        val hunks = DiffUtil.diff(old, new)
        val rebuilt = DiffUtil.applyAccepted(old, hunks, emptySet())
        assertThat(rebuilt).isEqualTo(old)
    }

    @Test
    fun applyAcceptedPartialKeepsRejectedSlices() {
        val old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm"
        val new = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm"
        val hunks = DiffUtil.diff(old, new)
        // Expect two distinct hunks (far apart enough that they aren't merged).
        assertThat(hunks.size).isGreaterThanOrEqualTo(2)
        // Accept only the first hunk → 'b' becomes 'B', but 'l' stays.
        val rebuilt = DiffUtil.applyAccepted(old, hunks, setOf(hunks[0].id))
        assertThat(rebuilt).contains("\nB\n").doesNotContain("\nL\n")
        assertThat(rebuilt).contains("\nl\n")
    }

    @Test
    fun pureAdditionAtEndApplies() {
        val old = "a\nb"
        val new = "a\nb\nc\nd"
        val hunks = DiffUtil.diff(old, new)
        val rebuilt = DiffUtil.applyAccepted(old, hunks, hunks.map { it.id }.toSet())
        assertThat(rebuilt).isEqualTo(new)
    }

    @Test
    fun pureDeletionApplies() {
        val old = "a\nb\nc\nd"
        val new = "a\nd"
        val hunks = DiffUtil.diff(old, new)
        val rebuilt = DiffUtil.applyAccepted(old, hunks, hunks.map { it.id }.toSet())
        assertThat(rebuilt).isEqualTo(new)
    }
}
