package io.codepilot.plugin.tools

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.psi.PsiManager
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.ProjectScope

/**
 * ★ SmartMatcher: Provides intelligent code location matching for the Agent.
 *
 * When the LLM references a file path or symbol that doesn't exist verbatim,
 * SmartMatcher uses fuzzy matching to find the best candidate:
 * - File path fuzzy matching (levenshtein distance)
 * - Symbol search via IntelliJ index
 * - Context-aware ranking based on recent edits
 */
class SmartMatcher(
    private val project: Project,
) {
    private val log = Logger.getInstance(SmartMatcher::class.java)

    data class MatchResult(
        val original: String,
        val matched: String,
        val score: Double,
        val type: String, // "file" or "symbol"
    )

    /**
     * Find the best match for a potentially incorrect file path.
     * Returns a list of candidates sorted by relevance score (descending).
     */
    fun matchFile(
        query: String,
        maxResults: Int = 5,
    ): List<MatchResult> {
        val root = PathGuard.projectRoot(project)
        val candidates = mutableListOf<MatchResult>()

        ApplicationManager.getApplication().runReadAction {
            // 1. Exact match (short-circuit)
            val exactVf = root.findFileByRelativePath(query)
            if (exactVf != null && exactVf.exists()) {
                candidates.add(MatchResult(query, query, 1.0, "file"))
                return@runReadAction
            }

            // 2. Filename-based fuzzy matching via IntelliJ index
            val fileName = query.substringAfterLast('/')
            val vfiles =
                FilenameIndex.getVirtualFilesByName(
                    fileName,
                    ProjectScope.getProjectScope(project),
                )

            for (vf in vfiles) {
                val rel = vf.path.removePrefix(root.path).trimStart('/')
                val score = computeFileScore(query, rel)
                if (score > 0.3) {
                    candidates.add(MatchResult(query, rel, score, "file"))
                }
            }

            // 3. Directory-path fuzzy matching (walk top-level dirs)
            val queryParts = query.split('/')
            if (queryParts.size > 1) {
                VfsUtil.processFilesRecursively(root) { f ->
                    if (!f.isDirectory && f.length < 1_048_576) {
                        val rel = f.path.removePrefix(root.path).trimStart('/')
                        // Quick path similarity check
                        if (pathSimilarity(query, rel) > 0.5) {
                            val score = computeFileScore(query, rel)
                            if (score > 0.4 && candidates.none { it.matched == rel }) {
                                candidates.add(MatchResult(query, rel, score, "file"))
                            }
                        }
                    }
                    true
                }
            }
        }

        return candidates.sortedByDescending { it.score }.take(maxResults)
    }

    /**
     * Find the best match for a symbol name.
     */
    fun matchSymbol(
        symbolName: String,
        maxResults: Int = 5,
    ): List<MatchResult> {
        val candidates = mutableListOf<MatchResult>()
        ApplicationManager.getApplication().runReadAction {
            // Use IntelliJ's symbol search for fuzzy matching
            val shortNames =
                com.intellij.openapi.project.DumbService
                    .getInstance(project)
            // Simple approach: search by class/method name patterns
            val psiManager = PsiManager.getInstance(project)
            // Use FilenameIndex as a proxy — full symbol search needs DumbService
            val vfiles =
                FilenameIndex.getVirtualFilesByName(
                    symbolName,
                    ProjectScope.getProjectScope(project),
                )
            for (vf in vfiles) {
                val root = PathGuard.projectRoot(project)
                val rel = vf.path.removePrefix(root.path).trimStart('/')
                candidates.add(MatchResult(symbolName, rel, 0.7, "symbol"))
            }
        }
        return candidates.sortedByDescending { it.score }.take(maxResults)
    }

    /** Compute a relevance score between a query path and a candidate path. */
    private fun computeFileScore(
        query: String,
        candidate: String,
    ): Double {
        if (query == candidate) return 1.0
        val qParts = query.lowercase().split("/")
        val cParts = candidate.lowercase().split("/")
        // Filename exact match
        if (qParts.last() == cParts.last()) return 0.9
        // Filename fuzzy match
        val nameScore = levenshteinScore(qParts.last(), cParts.last())
        // Path overlap
        val pathOverlap =
            qParts.intersect(cParts.toSet()).size.toDouble() /
                qParts.size.coerceAtLeast(1)
        return nameScore * 0.7 + pathOverlap * 0.3
    }

    private fun pathSimilarity(
        a: String,
        b: String,
    ): Double {
        val aParts = a.lowercase().split("/")
        val bParts = b.lowercase().split("/")
        return aParts.intersect(bParts.toSet()).size.toDouble() /
            maxOf(aParts.size, bParts.size).coerceAtLeast(1)
    }

    /** Normalized Levenshtein similarity (1.0 = identical, 0.0 = completely different). */
    private fun levenshteinScore(
        a: String,
        b: String,
    ): Double {
        val dist = levenshteinDistance(a, b)
        val maxLen = maxOf(a.length, b.length).coerceAtLeast(1)
        return 1.0 - dist.toDouble() / maxLen
    }

    private fun levenshteinDistance(
        a: String,
        b: String,
    ): Int {
        val dp = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) dp[i][0] = i
        for (j in 0..b.length) dp[0][j] = j
        for (i in 1..a.length) {
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                dp[i][j] = minOf(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
            }
        }
        return dp[a.length][b.length]
    }
}
