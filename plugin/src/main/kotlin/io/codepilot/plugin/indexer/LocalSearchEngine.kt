package io.codepilot.plugin.indexer

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
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
class LocalSearchEngine(
    private val project: Project,
) {
    private val log = Logger.getInstance(LocalSearchEngine::class.java)

    /** Inverted index: term → set of (path, chunkIndex) */
    private val invertedIndex = ConcurrentHashMap<String, MutableSet<ChunkRef>>()

    /** Forward index: path → chunks (for snippet retrieval) */
    private val forwardIndex = ConcurrentHashMap<String, List<ChunkBuilder.Chunk>>()

    /** Semantic embedding vectors: ChunkRef → sparse TF-IDF vector for semantic similarity */
    private val embeddingVectors = ConcurrentHashMap<ChunkRef, SparseVector>()

    /** BM25 parameters */
    private val avgDocLen =
        java.util.concurrent.atomic
            .AtomicReference(0.0)
    private val docCount =
        java.util.concurrent.atomic
            .AtomicInteger(0)
    private val docLenMap = ConcurrentHashMap<ChunkRef, Int>()

    data class ChunkRef(
        val path: String,
        val startLine: Int,
        val endLine: Int,
    )

    data class SearchHit(
        val path: String,
        val startLine: Int,
        val endLine: Int,
        val score: Double,
        val snippet: String,
        val symbols: List<String>,
        val matchType: String, // keyword, symbol, path, semantic, hybrid
    )

    /** Lightweight sparse vector for local semantic similarity. */
    data class SparseVector(
        val terms: Map<String, Double>,
    ) {
        fun cosine(other: SparseVector): Double {
            var dot = 0.0
            var normA = 0.0
            var normB = 0.0
            for ((term, weight) in this.terms) {
                normA += weight * weight
                val otherWeight = other.terms[term] ?: 0.0
                dot += weight * otherWeight
                normB += otherWeight * otherWeight
            }
            if (normB == 0.0) {
                for ((_, w) in other.terms) normB += w * w
            }
            val denom = Math.sqrt(normA) * Math.sqrt(normB)
            return if (denom > 0) dot / denom else 0.0
        }
    }

    /** Index a batch of chunks (called by IndexScheduler after building). */
    fun indexChunks(chunks: List<ChunkBuilder.Chunk>) {
        val totalDocs = (docCount.get() + chunks.size).coerceAtLeast(1).toDouble()
        for (chunk in chunks) {
            // Forward index
            forwardIndex.compute(chunk.path) { _, existing ->
                val list = existing?.toMutableList() ?: mutableListOf()
                list.removeAll { it.startLine == chunk.startLine && it.endLine == chunk.endLine }
                list.add(chunk)
                list
            }

            // Inverted index: tokenize content into terms
            val ref = ChunkRef(chunk.path, chunk.startLine, chunk.endLine)
            val allTerms = tokenize(chunk.content) + chunk.symbols.flatMap { tokenize(it) }
            for (term in allTerms.distinct()) {
                invertedIndex.computeIfAbsent(term) { ConcurrentHashMap.newKeySet() }.add(ref)
            }

            // Build sparse embedding vector (TF-IDF weighted)
            val termFreqs = mutableMapOf<String, Int>()
            for (term in allTerms) {
                termFreqs[term] = (termFreqs[term] ?: 0) + 1
            }
            val docLen = allTerms.size
            docLenMap[ref] = docLen

            val vectorTerms = mutableMapOf<String, Double>()
            for ((term, freq) in termFreqs) {
                val tf = freq.toDouble() / docLen.coerceAtLeast(1)
                val df = invertedIndex[term]?.size?.coerceAtLeast(1) ?: 1
                val idf = Math.log(totalDocs / df.toDouble())
                vectorTerms[term] = tf * idf
            }
            // Boost symbol terms for code-structure awareness
            for (symbol in chunk.symbols.distinct()) {
                for (symTerm in tokenize(symbol)) {
                    vectorTerms[symTerm] = (vectorTerms[symTerm] ?: 0.0) * 2.0
                }
            }
            embeddingVectors[ref] = SparseVector(vectorTerms)
        }
        docCount.addAndGet(chunks.size)
        updateAvgDocLen()
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
            embeddingVectors.remove(ref)
            docLenMap.remove(ref)
        }
        docCount.addAndGet(-chunks.size)
        updateAvgDocLen()
    }

    /**
     * Incremental re-index: remove old chunks for a path and index new ones.
     * This avoids full re-index by only updating the affected file's entries
     * and recomputing embeddings for changed chunks only.
     */
    fun reindexFile(path: String, newChunks: List<ChunkBuilder.Chunk>) {
        removeFile(path)
        indexChunks(newChunks)
        log.info("Incremental re-index: $path (${newChunks.size} chunks)")
    }

    /**
     * Get index statistics for diagnostics.
     */
    fun indexStats(): IndexStats {
        return IndexStats(
            totalChunks = forwardIndex.values.sumOf { it.size },
            totalFiles = forwardIndex.size,
            totalTerms = invertedIndex.size,
            totalEmbeddings = embeddingVectors.size,
            avgDocLen = avgDocLen.get(),
        )
    }

    data class IndexStats(
        val totalChunks: Int,
        val totalFiles: Int,
        val totalTerms: Int,
        val totalEmbeddings: Int,
        val avgDocLen: Double,
    )

    /**
     * Search the local index. Combines multiple strategies for best results.
     * Hybrid scoring: BM25 (40%) + semantic cosine (30%) + symbol boost (20%) + path boost (10%)
     */
    fun search(
        query: String,
        topK: Int = 20,
        language: String? = null,
    ): List<SearchHit> {
        val queryTerms = tokenize(query)
        if (queryTerms.isEmpty()) return emptyList()

        val scored = mutableMapOf<ChunkRef, Double>()
        val totalDocs = forwardIndex.size.coerceAtLeast(1).toDouble()
        val avgLen = avgDocLen.get().coerceAtLeast(1.0)

        // ─── Strategy 1: BM25 scoring (keyword relevance) ───
        val k1 = 1.2
        val b = 0.75
        for (term in queryTerms) {
            val refs = invertedIndex[term] ?: continue
            val df = refs.size.coerceAtLeast(1)
            val idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1.0)
            for (ref in refs) {
                val docLen = docLenMap[ref] ?: continue
                val tf = 1.0 // presence-based TF (term appears in chunk)
                val bm25Score = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgLen))
                scored[ref] = (scored[ref] ?: 0.0) + bm25Score
            }
        }

        // ─── Strategy 2: Partial/prefix matching for symbol names ───
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

        // ─── Strategy 3: File path matching bonus ───
        val queryLower = query.lowercase()
        for ((path, chunks) in forwardIndex) {
            if (path.lowercase().contains(queryLower)) {
                for (chunk in chunks) {
                    val ref = ChunkRef(path, chunk.startLine, chunk.endLine)
                    scored[ref] = (scored[ref] ?: 0.0) + 3.0
                }
            }
        }

        // ─── Strategy 4: Semantic similarity via sparse vector cosine ───
        val queryVector = buildQueryVector(queryTerms, totalDocs)
        val semanticScores = mutableMapOf<ChunkRef, Double>()
        for ((ref, docVector) in embeddingVectors) {
            val sim = queryVector.cosine(docVector)
            if (sim > 0.05) { // threshold to avoid noise
                semanticScores[ref] = sim
            }
        }

        // ─── Hybrid scoring: normalize + weighted merge ───
        val maxBm25 = scored.values.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
        val maxSemantic = semanticScores.values.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0

        val hybridScored = mutableMapOf<ChunkRef, Double>()
        // Collect all candidate refs from both strategies
        val allRefs = scored.keys + semanticScores.keys
        for (ref in allRefs) {
            val bm25Norm = (scored[ref] ?: 0.0) / maxBm25
            val semNorm = (semanticScores[ref] ?: 0.0) / maxSemantic
            val combined = 0.40 * bm25Norm + 0.30 * semNorm
            hybridScored[ref] = combined
        }

        // ─── Strategy 5: Symbol boost for exact symbol matches ───
        for (ref in hybridScored.keys.toList()) {
            val chunk =
                forwardIndex[ref.path]
                    ?.find { it.startLine == ref.startLine && it.endLine == ref.endLine } ?: continue
            val symbolMatch =
                chunk.symbols.any { sym ->
                    queryTerms.any { qt -> sym.lowercase().contains(qt) }
                }
            if (symbolMatch) {
                hybridScored[ref] = (hybridScored[ref] ?: 0.0) + 0.20
            }
        }

        // ─── Strategy 6: Path proximity boost ───
        for (ref in hybridScored.keys.toList()) {
            if (ref.path.lowercase().contains(queryLower)) {
                hybridScored[ref] = (hybridScored[ref] ?: 0.0) + 0.10
            }
        }

        // Filter by language if specified
        val filtered =
            if (language != null) {
                hybridScored.filter { (ref, _) ->
                    forwardIndex[ref.path]?.any { it.language.equals(language, ignoreCase = true) } == true
                }
            } else {
                hybridScored
            }

        // Sort by hybrid score, take topK, build results
        return filtered.entries
            .sortedByDescending { it.value }
            .take(topK)
            .mapNotNull { (ref, score) ->
                val chunk =
                    forwardIndex[ref.path]
                        ?.find { it.startLine == ref.startLine && it.endLine == ref.endLine }
                        ?: return@mapNotNull null

                val snippet = chunk.content.take(500)
                val matchType =
                    when {
                        chunk.symbols.any { it.lowercase().contains(queryLower) } -> "symbol"
                        ref.path.lowercase().contains(queryLower) -> "path"
                        (semanticScores[ref] ?: 0.0) / maxSemantic > 0.3 -> "semantic"
                        else -> "hybrid"
                    }

                SearchHit(
                    path = ref.path,
                    startLine = ref.startLine,
                    endLine = ref.endLine,
                    score = score,
                    snippet = snippet,
                    symbols = chunk.symbols,
                    matchType = matchType,
                )
            }
    }

    /**
     * Deep semantic search for @codebase — returns broader, conceptually related results.
     * Uses lower thresholds and considers structural similarity (shared symbols, import patterns).
     */
    fun semanticSearch(
        query: String,
        topK: Int = 30,
    ): List<SearchHit> {
        val queryTerms = tokenize(query)
        if (queryTerms.isEmpty()) return emptyList()

        val totalDocs = forwardIndex.size.coerceAtLeast(1).toDouble()
        val queryVector = buildQueryVector(queryTerms, totalDocs)

        // Score all documents by semantic similarity
        val scored = mutableMapOf<ChunkRef, Double>()
        for ((ref, docVector) in embeddingVectors) {
            val sim = queryVector.cosine(docVector)
            if (sim > 0.02) { // Lower threshold for deep search
                scored[ref] = sim
            }
        }

        // Boost chunks that share symbols with top candidates (structural relatedness)
        val topCandidates = scored.entries.sortedByDescending { it.value }.take(10)
        val topSymbols =
            topCandidates
                .mapNotNull { (ref, _) ->
                    forwardIndex[ref.path]?.find { it.startLine == ref.startLine && it.endLine == ref.endLine }
                }.flatMap { it.symbols }
                .toSet()

        for ((ref, score) in scored.entries.toList()) {
            val chunk =
                forwardIndex[ref.path]
                    ?.find { it.startLine == ref.startLine && it.endLine == ref.endLine } ?: continue
            val sharedSymbolCount = chunk.symbols.count { it in topSymbols }
            if (sharedSymbolCount > 0) {
                scored[ref] = score + 0.1 * sharedSymbolCount
            }
        }

        return scored.entries
            .sortedByDescending { it.value }
            .take(topK)
            .mapNotNull { (ref, score) ->
                val chunk =
                    forwardIndex[ref.path]
                        ?.find { it.startLine == ref.startLine && it.endLine == ref.endLine }
                        ?: return@mapNotNull null
                SearchHit(
                    path = ref.path,
                    startLine = ref.startLine,
                    endLine = ref.endLine,
                    score = score,
                    snippet = chunk.content.take(500),
                    symbols = chunk.symbols,
                    matchType = "semantic",
                )
            }
    }

    /** Quick file path search (for @file autocomplete). */
    fun searchFilePaths(
        query: String,
        limit: Int = 20,
    ): List<String> {
        val queryLower = query.lowercase()
        return forwardIndex.keys
            .filter { it.lowercase().contains(queryLower) }
            .sortedBy { it.length } // Prefer shorter paths (more specific matches)
            .take(limit)
    }

    /** Get all symbols across the index (for @symbol autocomplete). */
    fun searchSymbols(
        query: String,
        limit: Int = 20,
    ): List<Pair<String, String>> {
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
    fun stats(): IndexStats = indexStats()

    // ─── Adaptive Context Depth ─────────────────────────────────────

    /**
     * Adaptive-depth search: automatically adjusts topK and search strategy
     * based on the query's semantic complexity.
     *
     * Complexity heuristics:
     * - Short queries (1-2 terms): focused search, low topK (10)
     * - Medium queries (3-5 terms): standard search, medium topK (20)
     * - Long/complex queries (6+ terms or compound): deep search, high topK (50)
     * - Queries containing structural terms (class, function, implement, etc.)
     *   get symbol-boosted search
     * - Queries with "how to" / "explain" patterns get semantic-deep search
     *
     * Returns results with matchType="adaptive" to distinguish from fixed-depth calls.
     */
    fun adaptiveSearch(
        query: String,
        language: String? = null,
    ): List<SearchHit> {
        val complexity = assessQueryComplexity(query)

        val topK =
            when {
                complexity.termCount <= 2 -> 10
                complexity.termCount <= 5 -> 20
                else -> 50
            }

        // For structural queries, boost symbol search weight
        val results =
            if (complexity.isStructural) {
                val hits = search(query, topK = topK, language = language)
                // Re-boost symbol matches for structural queries
                hits.map { hit ->
                    if (hit.matchType == "symbol") {
                        hit.copy(score = hit.score * 1.5)
                    } else {
                        hit
                    }
                }
            } else if (complexity.isConceptual) {
                // For conceptual queries, merge keyword + semantic results
                val keywordHits = search(query, topK = topK / 2, language = language)
                val semanticHits = semanticSearch(query, topK = topK / 2)
                mergeAndDeduplicate(keywordHits, semanticHits, topK)
            } else {
                search(query, topK = topK, language = language)
            }

        // Tag results as adaptive for observability
        return results.map { it.copy(matchType = "adaptive") }
    }

    data class QueryComplexity(
        val termCount: Int,
        val isStructural: Boolean,
        val isConceptual: Boolean,
        val depth: String, // "shallow", "medium", "deep"
    )

    /**
     * Assess the complexity of a search query to determine optimal search depth.
     */
    private fun assessQueryComplexity(query: String): QueryComplexity {
        val terms = tokenize(query)
        val termCount = terms.size

        // Structural terms suggest the user is looking for specific code constructs
        val structuralKeywords =
            setOf(
                "class",
                "interface",
                "enum",
                "object",
                "struct",
                "type",
                "function",
                "method",
                "fun",
                "def",
                "func",
                "fn",
                "variable",
                "field",
                "property",
                "const",
                "val",
                "var",
                "implement",
                "extend",
                "inherit",
                "override",
                "abstract",
                "import",
                "module",
                "package",
                "namespace",
            )
        val isStructural = terms.any { it in structuralKeywords }

        // Conceptual patterns suggest the user wants understanding, not specific symbols
        val conceptualPatterns =
            listOf(
                Regex("\\bhow\\s+to\\b", RegexOption.IGNORE_CASE),
                Regex("\\bexplain\\b", RegexOption.IGNORE_CASE),
                Regex("\\bwhy\\b", RegexOption.IGNORE_CASE),
                Regex("\\bwhat\\s+is\\b", RegexOption.IGNORE_CASE),
                Regex("\\bdifference\\b", RegexOption.IGNORE_CASE),
                Regex("\\bpattern\\b", RegexOption.IGNORE_CASE),
                Regex("\\bapproach\\b", RegexOption.IGNORE_CASE),
                Regex("\\bbest\\s+practice\\b", RegexOption.IGNORE_CASE),
            )
        val isConceptual = conceptualPatterns.any { it.containsMatchIn(query) }

        val depth =
            when {
                termCount <= 2 -> "shallow"
                termCount <= 5 -> "medium"
                else -> "deep"
            }

        return QueryComplexity(
            termCount = termCount,
            isStructural = isStructural,
            isConceptual = isConceptual,
            depth = depth,
        )
    }

    /**
     * Merge keyword and semantic search results, deduplicate by (path, startLine),
     * and take combined topK results.
     */
    private fun mergeAndDeduplicate(
        keywordHits: List<SearchHit>,
        semanticHits: List<SearchHit>,
        topK: Int,
    ): List<SearchHit> {
        val merged = mutableMapOf<Pair<String, Int>, SearchHit>()

        for (hit in keywordHits) {
            val key = hit.path to hit.startLine
            val existing = merged[key]
            if (existing == null || hit.score > existing.score) {
                merged[key] = hit
            }
        }

        for (hit in semanticHits) {
            val key = hit.path to hit.startLine
            val existing = merged[key]
            if (existing == null) {
                merged[key] = hit
            } else {
                // Combine scores with weighting: keyword > semantic for precision
                val combinedScore = existing.score * 0.6 + hit.score * 0.4
                merged[key] = existing.copy(score = combinedScore)
            }
        }

        return merged.values
            .sortedByDescending { it.score }
            .take(topK)
    }

    fun clear() {
        invertedIndex.clear()
        forwardIndex.clear()
        embeddingVectors.clear()
        docLenMap.clear()
        docCount.set(0)
        avgDocLen.set(0.0)
    }

    // ─── Internal helpers ────────────────────────────────────────────

    private fun updateAvgDocLen() {
        val lens = docLenMap.values
        if (lens.isNotEmpty()) {
            avgDocLen.set(lens.average())
        }
    }

    private fun buildQueryVector(
        queryTerms: List<String>,
        totalDocs: Double,
    ): SparseVector {
        val termFreqs = mutableMapOf<String, Int>()
        for (term in queryTerms) {
            termFreqs[term] = (termFreqs[term] ?: 0) + 1
        }
        val docLen = queryTerms.size.coerceAtLeast(1)
        val vectorTerms = mutableMapOf<String, Double>()
        for ((term, freq) in termFreqs) {
            val tf = freq.toDouble() / docLen
            val df = invertedIndex[term]?.size?.coerceAtLeast(1) ?: 1
            val idf = Math.log(totalDocs / df.toDouble())
            vectorTerms[term] = tf * idf
        }
        return SparseVector(vectorTerms)
    }

    // ─── Tokenization ───────────────────────────────────────────────

    private fun tokenize(text: String): List<String> =
        text
            .replace(Regex("([a-z])([A-Z])"), "$1 $2")
            .replace(Regex("([A-Z]+)([A-Z][a-z])"), "$1 $2")
            .split(Regex("[^a-zA-Z0-9]+"))
            .map { it.lowercase() }
            .filter { it.length >= 2 }
}
