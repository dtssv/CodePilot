package io.codepilot.plugin.apply

/**
 * Line-level diff utility used by [PatchStaging] to break a (old, new) file pair into
 * independently acceptable hunks.
 *
 * Implementation is a pure-Kotlin LCS-based diff so unit tests run without an IDE
 * runtime. IntelliJ's `ComparisonManager` is available at runtime but is not used here
 * because (a) requiring `ProgressIndicator` makes it awkward to call from tests, and
 * (b) we already operate on small file pairs (single patch).
 */
object DiffUtil {
    /** A change inside a hunk. */
    data class Change(
        /** "ctx" (context, unchanged), "add", "del". */
        val kind: String,
        /** Raw line text without newline. */
        val text: String,
    )

    /**
     * A single hunk: contiguous block of changes plus leading/trailing context.
     */
    data class Hunk(
        val id: String,
        /** 1-based start line in old (0 if pure insertion at file start). */
        val oldStart: Int,
        val oldCount: Int,
        /** 1-based start line in new. */
        val newStart: Int,
        val newCount: Int,
        val changes: List<Change>,
    ) {
        fun toUnified(): String {
            val sb = StringBuilder()
            sb.append("@@ -").append(oldStart).append(',').append(oldCount)
                .append(" +").append(newStart).append(',').append(newCount).append(" @@\n")
            for (c in changes) {
                val sigil = when (c.kind) {
                    "add" -> "+"
                    "del" -> "-"
                    else -> " "
                }
                sb.append(sigil).append(c.text).append('\n')
            }
            return sb.toString()
        }
    }

    /** How many context lines to include around a change run. */
    private const val CONTEXT = 3

    /**
     * Compute hunks for two files. Lines are split on `\n` (trailing newline preserved).
     * Returns an empty list when the two contents are equal.
     */
    fun diff(oldText: String, newText: String): List<Hunk> {
        val oldLines = oldText.split('\n')
        val newLines = newText.split('\n')
        val ops = lcsDiff(oldLines, newLines)
        return groupIntoHunks(ops)
    }

    /**
     * Re-apply the accepted hunks to `oldText` returning the resulting content.
     * Accepted hunks come from [diff]; rejected hunks (not in [accepted]) are skipped
     * and their old lines are kept as-is.
     *
     * @param accepted   set of hunk ids to apply.
     * @param allHunks   the full hunk list (must match what was returned by [diff]).
     */
    fun applyAccepted(
        oldText: String,
        allHunks: List<Hunk>,
        accepted: Set<String>,
    ): String {
        if (allHunks.isEmpty()) return oldText
        val oldLines = oldText.split('\n')
        val sorted = allHunks.sortedBy { it.oldStartIdx() }
        val out = StringBuilder()
        var idx = 0
        for (h in sorted) {
            val anchor = h.oldStartIdx()
            while (idx < anchor && idx < oldLines.size) {
                out.append(oldLines[idx]); out.append('\n'); idx++
            }
            val isAccepted = h.id in accepted
            var consumedOld = 0
            for (c in h.changes) {
                when (c.kind) {
                    "ctx" -> { out.append(c.text); out.append('\n'); consumedOld++ }
                    "del" -> {
                        if (!isAccepted) { out.append(c.text); out.append('\n') }
                        consumedOld++
                    }
                    "add" -> {
                        if (isAccepted) { out.append(c.text); out.append('\n') }
                    }
                }
            }
            idx += consumedOld
        }
        while (idx < oldLines.size) {
            out.append(oldLines[idx]); out.append('\n'); idx++
        }
        if (out.isNotEmpty() && out.last() == '\n') out.deleteCharAt(out.length - 1)
        return out.toString()
    }

    private fun Hunk.oldStartIdx(): Int = (oldStart - 1).coerceAtLeast(0)

    // ----- LCS-based diff -----

    private sealed interface Op {
        val text: String
        data class Keep(override val text: String) : Op
        data class Add(override val text: String) : Op
        data class Del(override val text: String) : Op
    }

    private fun lcsDiff(a: List<String>, b: List<String>): List<Op> {
        val n = a.size; val m = b.size
        // Classic LCS table; OK for small files we patch interactively.
        val dp = Array(n + 1) { IntArray(m + 1) }
        for (i in n - 1 downTo 0) {
            for (j in m - 1 downTo 0) {
                dp[i][j] = if (a[i] == b[j]) dp[i + 1][j + 1] + 1
                else maxOf(dp[i + 1][j], dp[i][j + 1])
            }
        }
        val ops = ArrayList<Op>()
        var i = 0; var j = 0
        while (i < n && j < m) {
            when {
                a[i] == b[j] -> { ops.add(Op.Keep(a[i])); i++; j++ }
                dp[i + 1][j] >= dp[i][j + 1] -> { ops.add(Op.Del(a[i])); i++ }
                else -> { ops.add(Op.Add(b[j])); j++ }
            }
        }
        while (i < n) { ops.add(Op.Del(a[i])); i++ }
        while (j < m) { ops.add(Op.Add(b[j])); j++ }
        return ops
    }

    private fun groupIntoHunks(ops: List<Op>): List<Hunk> {
        // Find indices of change-bearing ops, then expand to include CONTEXT
        // unchanged neighbours on each side, merging neighbouring groups.
        val isChange = BooleanArray(ops.size) { ops[it] !is Op.Keep }
        if (isChange.all { !it }) return emptyList()

        data class Range(var lo: Int, var hi: Int)
        val ranges = mutableListOf<Range>()
        var k = 0
        while (k < ops.size) {
            if (isChange[k]) {
                val lo = (k - CONTEXT).coerceAtLeast(0)
                var end = k
                // Extend forward while changes (or short gaps shorter than 2*CONTEXT) continue.
                while (end < ops.size - 1) {
                    val next = (end + 1 until ops.size).firstOrNull { isChange[it] }
                        ?: break
                    if (next - end <= 2 * CONTEXT) end = next else break
                }
                val hi = (end + CONTEXT).coerceAtMost(ops.size - 1)
                if (ranges.isNotEmpty() && lo <= ranges.last().hi + 1) {
                    ranges.last().hi = maxOf(ranges.last().hi, hi)
                } else {
                    ranges.add(Range(lo, hi))
                }
                k = hi + 1
            } else k++
        }

        // Convert ranges into Hunks, tracking old/new line numbers.
        val hunks = ArrayList<Hunk>(ranges.size)
        var oldLine = 1; var newLine = 1; var cursor = 0
        for ((idx, r) in ranges.withIndex()) {
            // Advance counters across ops before this range (all are Keep by construction).
            while (cursor < r.lo) {
                oldLine++; newLine++; cursor++
            }
            val hunkOldStart = oldLine
            val hunkNewStart = newLine
            var oldCount = 0; var newCount = 0
            val changes = ArrayList<Change>(r.hi - r.lo + 1)
            while (cursor <= r.hi) {
                when (val op = ops[cursor]) {
                    is Op.Keep -> {
                        changes.add(Change("ctx", op.text))
                        oldLine++; newLine++; oldCount++; newCount++
                    }
                    is Op.Del -> {
                        changes.add(Change("del", op.text))
                        oldLine++; oldCount++
                    }
                    is Op.Add -> {
                        changes.add(Change("add", op.text))
                        newLine++; newCount++
                    }
                }
                cursor++
            }
            hunks.add(
                Hunk(
                    id = "h$idx",
                    oldStart = hunkOldStart,
                    oldCount = oldCount,
                    newStart = hunkNewStart,
                    newCount = newCount,
                    changes = changes,
                ),
            )
        }
        return hunks
    }
}
