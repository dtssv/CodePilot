package io.codepilot.harness.search

/**
 * Fuzzy path matcher via Levenshtein distance + path similarity heuristics.
 *
 * Sunk from plugin/tools/SmartMatcher.kt:120-172 (the pure-algorithm portion).
 * The PSI-based candidate-finding part (FilenameIndex / DumbService) stays in
 * the IDE adapter; this class only scores candidates once the adapter hands
 * them in.
 */
class PathFuzzyMatcher {

    data class PathMatch(val path: String, val score: Double, val matchType: String)

    /**
     * Score [query] against [candidates]. Higher = better. Combines:
     *   - filename exact/prefix match
     *   - path similarity (Levenshtein on path segments)
     *   - subsequence match for query → path
     */
    fun match(query: String, candidates: List<String>, maxResults: Int = 5): List<PathMatch> {
        val q = query.lowercase()
        val scored = candidates.map { c ->
            val score = computeFileScore(q, c.lowercase())
            PathMatch(c, score, scoreType(q, c.lowercase()))
        }.filter { it.score > 0.3 }
        return scored.sortedByDescending { it.score }.take(maxResults)
    }

    /**
     * Levenshtein edit distance. Sunk verbatim from SmartMatcher.levenshteinDistance.
     */
    fun levenshtein(a: String, b: String): Int {
        val m = a.length; val n = b.length
        if (m == 0) return n
        if (n == 0) return m
        val dp = IntArray(n + 1) { it }
        for (i in 1..m) {
            var prev = dp[0]; dp[0] = i
            for (j in 1..n) {
                val tmp = dp[j]
                dp[j] = if (a[i - 1] == b[j - 1]) prev else 1 + minOf(prev, dp[j], dp[j - 1])
                prev = tmp
            }
        }
        return dp[n]
    }

    /**
     * Score a query against a relative path. Sunk from SmartMatcher.computeFileScore.
     */
    private fun computeFileScore(query: String, path: String): Double {
        // Exact match
        if (path == query) return 1.0
        // Filename match
        val fileName = path.substringAfterLast('/')
        if (fileName == query) return 0.95
        if (fileName.startsWith(query)) return 0.85
        // Path similarity via Levenshtein
        val dist = levenshtein(query, path)
        val maxLen = maxOf(query.length, path.length).coerceAtLeast(1)
        val similarity = 1.0 - dist.toDouble() / maxLen
        if (similarity > 0.5) return similarity * 0.8
        // Subsequence match (query is a subsequence of path)
        if (isSubsequence(query, path)) return 0.6
        return 0.0
    }

    private fun isSubsequence(needle: String, haystack: String): Boolean {
        var i = 0
        for (c in haystack) {
            if (i < needle.length && needle[i] == c) i++
        }
        return i == needle.length
    }

    private fun scoreType(query: String, path: String): String = when {
        path == query -> "exact"
        path.substringAfterLast('/') == query -> "filename"
        path.substringAfterLast('/').startsWith(query) -> "prefix"
        isSubsequence(query, path) -> "subsequence"
        else -> "fuzzy"
    }
}
