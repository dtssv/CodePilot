package io.codepilot.harness.search

/**
 * Code search SPI (ADR-9: grep / structural / embedding three implementations,
 * pluggable).
 *
 * The harness loop never talks to a specific searcher — it depends on this
 * interface. Implementations:
 *   - [Bm25Searcher]      : pure JDK BM25 + TF-IDF cosine (sunk from
 *                            plugin/indexer/LocalSearchEngine.kt)
 *   - [RipgrepSearcher]   : ripgrep subprocess (Claude Code / Cursor use rg)
 *   - PythonEmbedder      : sentence-transformers subprocess (replaces the
 *                            never-wired-up ONNX reflection path)
 *
 * Implementations are composed: e.g. a default catalog wires Bm25 + ripgrep +
 * a TfidfEmbedder fallback; when the Python embedder is available it's swapped
 * in front of TfidfEmbedder.
 */
interface CodeSearcher {
    /** Grep-like search: pattern + options → hits. */
    suspend fun grep(pattern: String, opts: GrepOpts = GrepOpts()): List<Hit>

    /** Semantic search: free-text query → top-K scored hits. */
    suspend fun semantic(query: String, topK: Int = 20): List<Hit>
}

data class GrepOpts(
    val pathGlob: String? = null,
    val maxHits: Int = 100,
    val contextLines: Int = 0,
    val caseSensitive: Boolean = true,
)

/** A single search hit. path:line:column with a snippet and (optional) score. */
data class Hit(
    val path: String,
    val line: Int,
    val column: Int = 1,
    val lineContent: String,
    val contextBefore: List<String> = emptyList(),
    val contextAfter: List<String> = emptyList(),
    val score: Double = 0.0,
    val matchType: String = "grep",
)

/** A chunk of indexed source (sunk from LocalSearchEngine.SearchHit / ChunkBuilder.Chunk). */
data class IndexedChunk(
    val path: String,
    val startLine: Int,
    val endLine: Int,
    val content: String,
    val symbols: List<String> = emptyList(),
    val language: String? = null,
)

/** Reference to a chunk for scoring. */
data class ChunkRef(val path: String, val startLine: Int, val endLine: Int)
