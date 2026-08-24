package io.codepilot.harness.tool.builtin

/**
 * Three-way merge engine for code diffs.
 *
 * Pure Kotlin, zero IDE / Spring dependencies. Mirrors Cursor's merge capability:
 *   - The user has modified a file since the Agent last saw it
 *   - The Agent proposes changes based on an older version
 *   - A 3-way merge combines user edits with Agent edits
 *
 * Algorithm:
 *   1. Diff base→ours (user changes) and base→theirs (Agent changes) via LCS
 *   2. Merge non-overlapping regions automatically
 *   3. Mark overlapping regions as conflicts for user resolution
 *
 * Sunk from plugin/tools/ThreeWayMerger.kt (297 lines). The original's
 * `extractBase` (which shells out to git) stays in the IDE adapter because it
 * needs the workspace root; the merge algorithm here is fully pure.
 */
class MergeTool {

    /** Result of a 3-way merge operation. */
    data class MergeResult(
        val merged: String,
        val hasConflicts: Boolean,
        val conflicts: List<ConflictRegion>,
        val autoResolvedCount: Int,
    )

    /** A conflict region that requires user resolution. */
    data class ConflictRegion(
        val startLine: Int,
        val endLine: Int,
        val ours: String,
        val theirs: String,
        val base: String,
    )

    /** A diff hunk representing a change from base. */
    data class DiffHunk(
        val baseStart: Int,
        val baseEnd: Int,     // exclusive
        val newLines: List<String>,
        val type: HunkType,
    )

    enum class HunkType { INSERT, DELETE, REPLACE }

    /**
     * Perform a 3-way merge between three versions of a file.
     *
     * @param base   common ancestor version
     * @param ours   user's current version
     * @param theirs agent's proposed version
     */
    fun merge(base: String, ours: String, theirs: String): MergeResult {
        if (ours == theirs) return MergeResult(ours, false, emptyList(), 0)
        if (base == ours) return MergeResult(theirs, false, emptyList(), 0)
        if (base == theirs) return MergeResult(ours, false, emptyList(), 0)

        val baseLines = base.lines()
        val oursLines = ours.lines()
        val theirsLines = theirs.lines()

        val oursHunks = computeDiff(baseLines, oursLines)
        val theirsHunks = computeDiff(baseLines, theirsLines)

        return mergeHunks(baseLines, oursHunks, theirsHunks)
    }

    /**
     * Compute diff hunks between base and modified using LCS-based diff.
     */
    private fun computeDiff(baseLines: List<String>, modifiedLines: List<String>): List<DiffHunk> {
        val hunks = mutableListOf<DiffHunk>()
        val lcs = longestCommonSubsequence(baseLines, modifiedLines)

        var baseIdx = 0
        var modIdx = 0
        var lcsIdx = 0

        while (baseIdx < baseLines.size || modIdx < modifiedLines.size) {
            if (lcsIdx < lcs.size && baseIdx < baseLines.size && modIdx < modifiedLines.size
                && baseLines[baseIdx] == lcs[lcsIdx] && modifiedLines[modIdx] == lcs[lcsIdx]
            ) {
                baseIdx++; modIdx++; lcsIdx++
            } else {
                val changeBaseStart = baseIdx
                val changeModStart = modIdx

                while (baseIdx < baseLines.size && (lcsIdx >= lcs.size || baseLines[baseIdx] != lcs[lcsIdx])) baseIdx++
                while (modIdx < modifiedLines.size && (lcsIdx >= lcs.size || modifiedLines[modIdx] != lcs[lcsIdx])) modIdx++

                val newLines = modifiedLines.subList(changeModStart, modIdx).toList()
                val type = when {
                    changeBaseStart == baseIdx -> HunkType.INSERT
                    changeModStart == modIdx -> HunkType.DELETE
                    else -> HunkType.REPLACE
                }
                hunks.add(DiffHunk(changeBaseStart, baseIdx, newLines, type))
            }
        }
        return hunks
    }

    /**
     * Merge two sets of hunks against the same base.
     */
    private fun mergeHunks(
        baseLines: List<String>,
        oursHunks: List<DiffHunk>,
        theirsHunks: List<DiffHunk>,
    ): MergeResult {
        val result = mutableListOf<String>()
        val conflicts = mutableListOf<ConflictRegion>()
        var autoResolved = 0
        var baseIdx = 0

        val allHunks = (oursHunks.map { "ours" to it } + theirsHunks.map { "theirs" to it })
            .sortedBy { it.second.baseStart }

        var i = 0
        while (i < allHunks.size) {
            val (_, hunk1) = allHunks[i]

            while (baseIdx < hunk1.baseStart && baseIdx < baseLines.size) {
                result.add(baseLines[baseIdx]); baseIdx++
            }

            var j = i + 1
            while (j < allHunks.size && allHunks[j].second.baseStart < hunk1.baseEnd) j++

            if (j > i + 1) {
                val (side2, hunk2) = allHunks[i + 1]
                if (hunk1.newLines == hunk2.newLines) {
                    result.addAll(hunk1.newLines); autoResolved++
                    baseIdx = maxOf(hunk1.baseEnd, hunk2.baseEnd)
                    i += 2
                } else {
                    val conflictStart = result.size
                    val oursContent = hunk1.newLines.joinToString("\n")
                    val theirsContent = hunk2.newLines.joinToString("\n")
                    val baseContent = baseLines.subList(
                        minOf(hunk1.baseStart, hunk2.baseStart),
                        maxOf(hunk1.baseEnd, hunk2.baseEnd)
                    ).joinToString("\n")

                    result.add("<<<<<<< OURS")
                    result.addAll(hunk1.newLines)
                    result.add("=======")
                    result.addAll(hunk2.newLines)
                    result.add(">>>>>>> THEIRS")

                    conflicts.add(ConflictRegion(conflictStart, result.size, oursContent, theirsContent, baseContent))
                    baseIdx = maxOf(hunk1.baseEnd, hunk2.baseEnd)
                    i += 2
                }
            } else {
                result.addAll(hunk1.newLines)
                baseIdx = hunk1.baseEnd
                i++
            }
        }

        while (baseIdx < baseLines.size) { result.add(baseLines[baseIdx]); baseIdx++ }

        return MergeResult(
            merged = result.joinToString("\n"),
            hasConflicts = conflicts.isNotEmpty(),
            conflicts = conflicts,
            autoResolvedCount = autoResolved,
        )
    }

    /**
     * Compute longest common subsequence of two string lists.
     * Classic DP: O(m*n) time and space; good enough for source files.
     */
    private fun longestCommonSubsequence(a: List<String>, b: List<String>): List<String> {
        val m = a.size
        val n = b.size
        val dp = Array(m + 1) { IntArray(n + 1) }
        for (i in 1..m) {
            for (j in 1..n) {
                if (a[i - 1] == b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
                else dp[i][j] = maxOf(dp[i - 1][j], dp[i][j - 1])
            }
        }
        val lcs = mutableListOf<String>()
        var i = m; var j = n
        while (i > 0 && j > 0) {
            if (a[i - 1] == b[j - 1]) { lcs.add(0, a[i - 1]); i--; j-- }
            else if (dp[i - 1][j] > dp[i][j - 1]) i-- else j--
        }
        return lcs
    }
}
