package io.codepilot.plugin.indexer

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.psi.PsiManager
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/**
 * Pure-local codebase search engine. No backend dependency.
 *
 * Reasons for local-only design:
 * 1. Code already exists on disk — no need to upload then re-download
 * 2. IDEA PSI provides the best code understanding, better than any backend embedding
 * 3. Uploading code to backend violates the "no user code persistence" design principle
 * 4. Network latency is unacceptable for real-time search
 * 5. Cursor also uses a purely local index
 *
 * Search strategies (in order of preference):
 * - Symbol search: exact class/method/field name match via PSI short names cache
 * - Keyword search: trigram-based content matching in indexed chunks
 * - File path search: fuzzy file name matching
 * - Semantic search: TF-IDF scoring over chunk content (lightweight, no embeddings needed)
 *
 * For true semantic search with embeddings, the model call itself already
 * provides context retrieval via ContextBudgeter sending relevant refs.
 */
class LocalSearchEngine(private val project: Project) {

    private val log = Logger.getInstance(LocalSearchEngine::class.java)

    /** Inverted index: term → set of (path, chunkIndex) */
    private val invertedIndex = ConcurrentHashMap<String, MutableSet<ChunkRef>>()

    /** Forward index: path → chunks (for snippet retrieval) */
    private val forwardIndex = ConcurrentHashMap<String, List<ChunkBuilder.Chunk>>()

    data class ChunkRef(val path: String, val startLine: Int, val endLine: Int)

    data class SearchHit(
        val path: String,
        val startLine: Int,
        val endLine: Int,
        val score: Double,
        val snippet: String,
        val symbols: List<String>,
        val matchType: String, // keyword, symbol, path, content
    )

    /** Index a batch of chunks (called by IndexScheduler after building). */
    fun indexChunks(chunks: List<ChunkBuilder.Chunk>) {
        for (chunk in chunks) {
            // Forward index
            forwardIndex.compute(chunk.path) { _, existing ->
                val list = existing?.toMutableList() ?: mutableListOf()
                // Remove old chunks for same range, add new
                list.removeAll { it.startLine == chunk.startLine && it.endLine == chunk.endLine }
                list.add(chunk)
                list
            }

            // Inverted index: tokenize content into terms
            val ref = ChunkRef(chunk.path, chunk.startLine, chunk.endLine)
            val terms = tokenize(chunk.content) + chunk.symbols.flatMap { tokenize(it) }
            for (term in terms.distinct()) {
                invertedIndex.computeIfAbsent(term) { ConcurrentHashMap.newKeySet() }.add(ref)
            }
        }
    }

    /** Remove all index entries for a file path. */
    fun removeFile(path: String) {
        val chunks = forwardIndex.remove(path) ?: return
        for (chunk in chunks) {
            val ref = ChunkRef(chunk.path, chunk.startLine, chunk.endLine)
            val terms = tokenize(chunk.content) + chunk.symbols.flatMap { tokenize(it) }
            for (term in terms.distinct()) {
                invertedIndex[term]?.remove(ref)
            }
        }
    }

    /**
     * Search the local index. Combines multiple strategies for best results.
     */
    fun search(query: String, topK: Int = 20, language: String? = null): List<SearchHit> {
        val queryTerms = tokenize(query)
        if (queryTerms.isEmpty()) return emptyList()

        val scored = mutableMapOf<ChunkRef, Double>()

        // Strategy 1: Exact term matching with TF-IDF-like scoring
        val totalDocs = forwardIndex.size.coerceAtLeast(1).toDouble()
        for (term in queryTerms) {
            val refs = invertedIndex[term] ?: continue
            val idf = Math.log(totalDocs / refs.size.coerceAtLeast(1).toDouble())
            for (ref in refs) {
                scored[ref] = (scored[ref] ?: 0.0) + idf
            }
        }

        // Strategy 2: Partial/prefix matching for symbol names
        for (term in queryTerms) {
            if (term.length < 3) continue
            for ((indexTerm, refs) in invertedIndex) {
                if (indexTerm.startsWith(term) && indexTerm != term) {
                    val bonus = 0.5 * Math.log(totalDocs / refs.size.coerceAtLeast(1).toDouble())
                    for (ref in refs) {
                        scored[ref] = (scored[ref] ?: 0.0) + bonus
                    }
                }
            }
        }

        // Strategy 3: File path matching bonus
        val queryLower = query.lowercase()
        for ((path, chunks) in forwardIndex) {
            if (path.lowercase().contains(queryLower)) {
                for (chunk in chunks) {
                    val ref = ChunkRef(path, chunk.startLine, chunk.endLine)
                    scored[ref] = (scored[ref] ?: 0.0) + 3.0 // Strong bonus for path match
                }
            }
        }

        // Filter by language if specified
        val filtered = if (language != null) {
            scored.filter { (ref, _) ->
                forwardIndex[ref.path]?.any { it.language.equals(language, ignoreCase = true) } == true
            }
        } else scored

        // Sort by score, take topK, build results
        return filtered.entries
            .sortedByDescending { it.value }
            .take(topK)
            .mapNotNull { (ref, score) ->
                val chunk = forwardIndex[ref.path]
                    ?.find { it.startLine == ref.startLine && it.endLine == ref.endLine }
                    ?: return@mapNotNull null

                val snippet = chunk.content.take(500)
                val matchType = when {
                    chunk.symbols.any { it.lowercase().contains(queryLower) } -> "symbol"
                    ref.path.lowercase().contains(queryLower) -> "path"
                    else -> "content"
                }

                SearchHit(
                    path = ref.path,
                    startLine = ref.startLine,
                    endLine = ref.endLine,
                    score = score / queryTerms.size, // Normalize
                    snippet = snippet,
                    symbols = chunk.symbols,
                    matchType = matchType,
                )
            }
    }

    /** Quick file path search (for @file autocomplete). */
    fun searchFilePaths(query: String, limit: Int = 20): List<String> {
        val queryLower = query.lowercase()
        return forwardIndex.keys
            .filter { it.lowercase().contains(queryLower) }
            .sortedBy { it.length } // Prefer shorter paths (more specific matches)
            .take(limit)
    }

    /** Get all symbols across the index (for @symbol autocomplete). */
    fun searchSymbols(query: String, limit: Int = 20): List<Pair<String, String>> {
        val queryLower = query.lowercase()
        val results = mutableListOf<Pair<String, String>>() // (symbol, path)
        for ((path, chunks) in forwardIndex) {
            for (chunk in chunks) {
                for (symbol in chunk.symbols) {
                    if (symbol.lowercase().contains(queryLower)) {
                        results.add(symbol to path)
                        if (results.size >= limit) return results
                    }
                }
            }
        }
        return results
    }

    /** Get stats for display. */
    fun stats(): IndexStats {
        return IndexStats(
            totalFiles = forwardIndex.size,
            totalChunks = forwardIndex.values.sumOf { it.size },
            totalTerms = invertedIndex.size,
        )
    }

    data class IndexStats(val totalFiles: Int, val totalChunks: Int, val totalTerms: Int)

    fun clear() {
        invertedIndex.clear()
        forwardIndex.clear()
    }

    // ─── Tokenization ───────────────────────────────────────────────

    private fun tokenize(text: String): List<String> {
        // Split on non-alphanumeric, camelCase boundaries, and underscores
        return text
            .replace(Regex("([a-z])([A-Z])"), "$1 $2") // camelCase split
            .replace(Regex("([A-Z]+)([A-Z][a-z])"), "$1 $2") // HTTPServer → HTTP Server
            .split(Regex("[^a-zA-Z0-9]+"))
            .map { it.lowercase() }
            .filter { it.length >= 2 } // Skip single chars
    }
}