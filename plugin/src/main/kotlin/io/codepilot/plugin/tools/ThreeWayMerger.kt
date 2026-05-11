package io.codepilot.plugin.tools

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import java.nio.charset.StandardCharsets

/**
 * Three-way merge engine for code diffs.
 *
 * <p>Mirrors Cursor's merge capability that handles cases where:
 * <ul>
 *   <li>The user has modified a file since the Agent last saw it</li>
 *   <li>The Agent proposes changes based on an older version</li>
 *   <li>A 3-way merge is needed to combine user edits with Agent edits</li>
 * </ul>
 *
 * <h3>Algorithm:</h3>
 * <ol>
 *   <li>Extract common ancestor (base) from Git or snapshot</li>
 *   <li>Diff base→ours (user changes) and base→theirs (Agent changes)</li>
 *   <li>Merge non-overlapping regions automatically</li>
 *   <li>Mark overlapping regions as conflicts for user resolution</li>
 * </ol>
 */
class ThreeWayMerger(private val project: Project) {

    private val log = Logger.getInstance(ThreeWayMerger::class.java)

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
        val ours: String,    // User's version
        val theirs: String,  // Agent's version
        val base: String,    // Common ancestor version
    )

    /**
     * Perform a 3-way merge between three versions of a file.
     *
     * @param base   common ancestor version
     * @param ours   user's current version
     * @param theirs agent's proposed version
     * @return merge result with conflicts if any
     */
    fun merge(base: String, ours: String, theirs: String): MergeResult {
        if (ours == theirs) {
            // Both sides made the same change
            return MergeResult(ours, false, emptyList(), 0)
        }
        if (base == ours) {
            // Only Agent changed
            return MergeResult(theirs, false, emptyList(), 0)
        }
        if (base == theirs) {
            // Only user changed
            return MergeResult(ours, false, emptyList(), 0)
        }

        // Full 3-way merge required
        val baseLines = base.lines()
        val oursLines = ours.lines()
        val theirsLines = theirs.lines()

        // Compute diffs from base
        val oursHunks = computeDiff(baseLines, oursLines)
        val theirsHunks = computeDiff(baseLines, theirsLines)

        // Merge hunks
        return mergeHunks(baseLines, oursHunks, theirsHunks, oursLines, theirsLines)
    }

    /**
     * Extract the common ancestor of a file from Git.
     * Uses git merge-base or falls back to HEAD version.
     */
    fun extractBase(filePath: String): String? {
        return try {
            val result = ShellExecutor.execute(
                project,
                "git merge-base HEAD @{upstream} 2>/dev/null || git rev-parse HEAD",
                project.basePath,
                5000
            )
            if (result.exitCode != 0) return null

            val commitHash = result.stdout.trim().lines().first().trim()
            if (commitHash.isBlank()) return null

            val showResult = ShellExecutor.execute(
                project,
                "git show $commitHash:$filePath",
                project.basePath,
                5000
            )
            if (showResult.exitCode != 0) null else showResult.stdout
        } catch (e: Exception) {
            log.warn("Failed to extract git base for $filePath: ${e.message}")
            null
        }
    }

    /**
     * A diff hunk representing a change from base.
     */
    data class DiffHunk(
        val baseStart: Int,
        val baseEnd: Int,     // exclusive
        val newLines: List<String>,
        val type: HunkType,
    )

    enum class HunkType { INSERT, DELETE, REPLACE }

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
                baseIdx++
                modIdx++
                lcsIdx++
            } else {
                // Find the extent of the change
                val changeBaseStart = baseIdx
                val changeModStart = modIdx

                // Skip non-matching lines
                while (baseIdx < baseLines.size && (lcsIdx >= lcs.size || baseLines[baseIdx] != lcs[lcsIdx])) {
                    baseIdx++
                }
                while (modIdx < modifiedLines.size && (lcsIdx >= lcs.size || modifiedLines[modIdx] != lcs[lcsIdx])) {
                    modIdx++
                }

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
        oursLines: List<String>,
        theirsLines: List<String>,
    ): MergeResult {
        val result = mutableListOf<String>()
        val conflicts = mutableListOf<ConflictRegion>()
        var autoResolved = 0
        var baseIdx = 0

        // Merge-sort both hunk lists by base position
        val allHunks = (oursHunks.map { "ours" to it } + theirsHunks.map { "theirs" to it })
            .sortedBy { it.second.baseStart }

        var i = 0
        while (i < allHunks.size) {
            val (side1, hunk1) = allHunks[i]

            // Add unchanged base lines before this hunk
            while (baseIdx < hunk1.baseStart && baseIdx < baseLines.size) {
                result.add(baseLines[baseIdx])
                baseIdx++
            }

            // Check for overlapping hunks from the other side
            var j = i + 1
            while (j < allHunks.size && allHunks[j].second.baseStart < hunk1.baseEnd) {
                j++
            }

            if (j > i + 1) {
                // Overlapping hunks — potential conflict
                val (side2, hunk2) = allHunks[i + 1]

                if (hunk1.newLines == hunk2.newLines) {
                    // Same change on both sides — no conflict
                    result.addAll(hunk1.newLines)
                    autoResolved++
                    baseIdx = maxOf(hunk1.baseEnd, hunk2.baseEnd)
                    i += 2
                } else {
                    // Real conflict
                    val conflictStart = result.size
                    val oursContent = hunk1.newLines.joinToString("\n")
                    val theirsContent = hunk2.newLines.joinToString("\n")
                    val baseContent = baseLines.subList(
                        minOf(hunk1.baseStart, hunk2.baseStart),
                        maxOf(hunk1.baseEnd, hunk2.baseEnd)
                    ).joinToString("\n")

                    // Add conflict markers
                    result.add("<<<<<<< OURS")
                    result.addAll(hunk1.newLines)
                    result.add("=======")
                    result.addAll(hunk2.newLines)
                    result.add(">>>>>>> THEIRS")

                    conflicts.add(ConflictRegion(
                        conflictStart,
                        result.size,
                        oursContent,
                        theirsContent,
                        baseContent
                    ))
                    baseIdx = maxOf(hunk1.baseEnd, hunk2.baseEnd)
                    i += 2
                }
            } else {
                // Non-overlapping hunk — apply directly
                result.addAll(hunk1.newLines)
                baseIdx = hunk1.baseEnd
                i++
            }
        }

        // Add remaining base lines
        while (baseIdx < baseLines.size) {
            result.add(baseLines[baseIdx])
            baseIdx++
        }

        return MergeResult(
            merged = result.joinToString("\n"),
            hasConflicts = conflicts.isNotEmpty(),
            conflicts = conflicts,
            autoResolvedCount = autoResolved
        )
    }

    /**
     * Compute longest common subsequence of two string lists.
     * Used as the basis for diff computation.
     */
    private fun longestCommonSubsequence(a: List<String>, b: List<String>): List<String> {
        val m = a.size
        val n = b.size
        val dp = Array(m + 1) { IntArray(n + 1) }

        for (i in 1..m) {
            for (j in 1..n) {
                if (a[i - 1] == b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1
                } else {
                    dp[i][j] = maxOf(dp[i - 1][j], dp[i][j - 1])
                }
            }
        }

        // Backtrack to find LCS
        val lcs = mutableListOf<String>()
        var i = m
        var j = n
        while (i > 0 && j > 0) {
            if (a[i - 1] == b[j - 1]) {
                lcs.add(0, a[i - 1])
                i--
                j--
            } else if (dp[i - 1][j] > dp[i][j - 1]) {
                i--
            } else {
                j--
            }
        }

        return lcs
    }
}