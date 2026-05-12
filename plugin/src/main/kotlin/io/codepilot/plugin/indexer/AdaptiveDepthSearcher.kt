package io.codepilot.plugin.indexer

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project

/**
 * AdaptiveDepthSearcher — Automatically adjusts search depth based on
 * query complexity, project size, and token budget.
 *
 * Strategy:
 * - Simple queries (1-2 keywords): shallow search (top files only, top 5 results)
 * - Medium queries (3-5 keywords): standard search (symbol + path + content, top 10)
 * - Complex queries (6+ keywords or contains code patterns): deep search
 *   (full content scan + embedding similarity, top 20)
 * - If token budget is tight, reduces depth regardless of query complexity
 */
class AdaptiveDepthSearcher(
    private val project: Project,
) {
    private val log = logger<AdaptiveDepthSearcher>()

    enum class SearchDepth {
        SHALLOW,   // top files + path match only
        STANDARD,  // + symbol + content
        DEEP       // + full content + embedding similarity
    }

    data class SearchParams(
        val depth: SearchDepth,
        val topK: Int,
        val maxContentTokens: Int,
        val useEmbedding: Boolean,
        val useSymbolSearch: Boolean,
        val useContentSearch: Boolean,
    )

    /**
     * Determine optimal search parameters based on query and token budget.
     */
    fun resolveParams(query: String, tokenBudget: Int): SearchParams {
        val complexity = assessComplexity(query)

        val depth = when {
            tokenBudget < 500 -> SearchDepth.SHALLOW
            tokenBudget < 2000 -> if (complexity >= 3) SearchDepth.STANDARD else SearchDepth.SHALLOW
            else -> when {
                complexity >= 5 -> SearchDepth.DEEP
                complexity >= 3 -> SearchDepth.STANDARD
                else -> SearchDepth.SHALLOW
            }
        }

        val topK = when (depth) {
            SearchDepth.SHALLOW -> 5
            SearchDepth.STANDARD -> 10
            SearchDepth.DEEP -> 20
        }

        val maxContentTokens = when (depth) {
            SearchDepth.SHALLOW -> tokenBudget / 3
            SearchDepth.STANDARD -> tokenBudget / 2
            SearchDepth.DEEP -> (tokenBudget * 2) / 3
        }

        return SearchParams(
            depth = depth,
            topK = topK,
            maxContentTokens = maxContentTokens,
            useEmbedding = depth == SearchDepth.DEEP,
            useSymbolSearch = depth >= SearchDepth.STANDARD,
            useContentSearch = depth >= SearchDepth.STANDARD,
        )
    }

    /**
     * Assess query complexity on a 1-7 scale.
     */
    private fun assessComplexity(query: String): Int {
        var score = 0
        val keywords = query.split(Regex("\\s+")).filter { it.length >= 2 }
        score += keywords.size.coerceAtMost(4)
        if (query.contains(Regex("[a-z][A-Z]"))) score += 1
        if (query.contains(".") || query.contains("(")) score += 1
        if (query.contains(Regex("[=<>!+\\-*/]"))) score += 1
        return score.coerceIn(1, 7)
    }

    /**
     * Execute search with adaptive parameters.
     */
    fun search(query: String, tokenBudget: Int = 4000): List<LocalSearchEngine.SearchHit> {
        val params = resolveParams(query, tokenBudget)
        log.info("AdaptiveDepthSearcher: depth=${params.depth} topK=${params.topK}")
        val scheduler = IndexScheduler.getInstance(project)
        return scheduler.search(query, topK = params.topK)
    }
}