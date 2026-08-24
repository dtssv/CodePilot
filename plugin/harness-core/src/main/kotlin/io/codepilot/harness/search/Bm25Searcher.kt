package io.codepilot.harness.search

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.streams.toList

/**
 * Pure-JDK BM25 + sparse TF-IDF cosine hybrid searcher.
 *
 * Sunk from plugin/indexer/LocalSearchEngine.kt (631 lines). The original is a
 * `@Service(Level.APP)` IntelliJ project service with PSI/VFS plumbing; here
 * we keep only the scoring algorithm and the in-memory index state. The IDE
 * adapter feeds IndexedChunks via [indexChunks]; the harness loop queries via
 * [grep] (regex over all indexed content) and [semantic] (BM25 + cosine).
 *
 * Hybrid scoring (matches the original):
 *   0.40 * BM25_norm + 0.30 * cosine_norm + 0.20 * symbol_match + 0.10 * path_match
 * plus prefix-bonus and partial term matching.
 */
class Bm25Searcher(
    private val root: Path,
) : CodeSearcher {
    private val forwardIndex = ConcurrentHashMap<String, MutableList<IndexedChunk>>()
    private val invertedIndex = ConcurrentHashMap<String, MutableSet<ChunkRef>>()
    private val embeddingVectors = ConcurrentHashMap<ChunkRef, SparseVector>()
    private val docLenMap = ConcurrentHashMap<ChunkRef, Int>()
    private val docCount = AtomicInteger(0)
    private val avgDocLen = AtomicReference(0.0)

    fun indexChunks(chunks: List<IndexedChunk>) {
        val totalDocs = (docCount.get() + chunks.size).coerceAtLeast(1).toDouble()
        for (chunk in chunks) {
            forwardIndex.compute(chunk.path) { _, existing ->
                val list = existing?.toMutableList() ?: mutableListOf()
                list.removeAll { it.startLine == chunk.startLine && it.endLine == chunk.endLine }
                list.add(chunk); list
            }
            val ref = ChunkRef(chunk.path, chunk.startLine, chunk.endLine)
            val allTerms = tokenize(chunk.content) + chunk.symbols.flatMap { tokenize(it) }
            for (term in allTerms.distinct()) {
                invertedIndex.computeIfAbsent(term) { ConcurrentHashMap.newKeySet() }.add(ref)
            }
            val termFreqs = mutableMapOf<String, Int>()
            for (term in allTerms) termFreqs[term] = (termFreqs[term] ?: 0) + 1
            val docLen = allTerms.size
            docLenMap[ref] = docLen
            val vecTerms = mutableMapOf<String, Double>()
            for ((term, freq) in termFreqs) {
                val tf = freq.toDouble() / docLen.coerceAtLeast(1)
                val df = invertedIndex[term]?.size?.coerceAtLeast(1) ?: 1
                val idf = Math.log(totalDocs / df.toDouble())
                vecTerms[term] = tf * idf
            }
            for (symbol in chunk.symbols.distinct()) {
                for (symTerm in tokenize(symbol)) vecTerms[symTerm] = (vecTerms[symTerm] ?: 0.0) * 2.0
            }
            embeddingVectors[ref] = SparseVector(vecTerms)
        }
        docCount.addAndGet(chunks.size)
        updateAvgDocLen()
    }

    fun removeFile(path: String) {
        val chunks = forwardIndex.remove(path) ?: return
        for (chunk in chunks) {
            val ref = ChunkRef(chunk.path, chunk.startLine, chunk.endLine)
            val terms = tokenize(chunk.content) + chunk.symbols.flatMap { tokenize(it) }
            for (term in terms.distinct()) invertedIndex[term]?.remove(ref)
            embeddingVectors.remove(ref)
            docLenMap.remove(ref)
        }
        docCount.addAndGet(-chunks.size)
        updateAvgDocLen()
    }

    fun reindexFile(path: String, newChunks: List<IndexedChunk>) {
        removeFile(path)
        indexChunks(newChunks)
    }

    fun clear() {
        invertedIndex.clear(); forwardIndex.clear(); embeddingVectors.clear()
        docLenMap.clear(); docCount.set(0); avgDocLen.set(0.0)
    }

    fun indexStats(): IndexStats = IndexStats(
        totalChunks = forwardIndex.values.sumOf { it.size },
        totalFiles = forwardIndex.size,
        totalTerms = invertedIndex.size,
        totalEmbeddings = embeddingVectors.size,
        avgDocLen = avgDocLen.get(),
    )

    data class IndexStats(
        val totalChunks: Int, val totalFiles: Int, val totalTerms: Int,
        val totalEmbeddings: Int, val avgDocLen: Double,
    )

    override suspend fun grep(pattern: String, opts: GrepOpts): List<Hit> {
        val regex = if (opts.caseSensitive) Regex(pattern) else Regex(pattern, RegexOption.IGNORE_CASE)
        val hits = mutableListOf<Hit>()
        Files.walk(root).use { stream ->
            stream.filter { it.isRegularFile() && !isBinaryPath(it) }.toList().forEach { f ->
                if (hits.size >= opts.maxHits) return@forEach
                val relPath = root.relativize(f).toString()
                runCatching {
                    f.readText().lineSequence().forEachIndexed { i, line ->
                        if (hits.size < opts.maxHits && regex.containsMatchIn(line)) {
                            hits.add(Hit(
                                path = relPath, line = i + 1, lineContent = line.take(300),
                                matchType = "grep",
                            ))
                        }
                    }
                }
            }
        }
        return hits
    }

    override suspend fun semantic(query: String, topK: Int): List<Hit> {
        val queryTerms = tokenize(query)
        if (queryTerms.isEmpty()) return emptyList()

        val scored = mutableMapOf<ChunkRef, Double>()
        val totalDocs = forwardIndex.size.coerceAtLeast(1).toDouble()
        val avgLen = avgDocLen.get().coerceAtLeast(1.0)
        val k1 = 1.2; val b = 0.75
        for (term in queryTerms) {
            val refs = invertedIndex[term] ?: continue
            val df = refs.size.coerceAtLeast(1)
            val idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1.0)
            for (ref in refs) {
                val docLen = docLenMap[ref] ?: continue
                val tf = 1.0
                val bm25 = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgLen))
                scored[ref] = (scored[ref] ?: 0.0) + bm25
            }
        }
        // prefix-bonus
        for (term in queryTerms) {
            if (term.length < 3) continue
            for ((indexTerm, refs) in invertedIndex) {
                if (indexTerm.startsWith(term) && indexTerm != term) {
                    val bonus = 0.5 * Math.log(totalDocs / refs.size.coerceAtLeast(1).toDouble())
                    for (ref in refs) scored[ref] = (scored[ref] ?: 0.0) + bonus
                }
            }
        }
        // path bonus
        val queryLower = query.lowercase()
        for ((path, chunks) in forwardIndex) {
            if (path.lowercase().contains(queryLower)) {
                for (chunk in chunks) {
                    val ref = ChunkRef(path, chunk.startLine, chunk.endLine)
                    scored[ref] = (scored[ref] ?: 0.0) + 3.0
                }
            }
        }
        // semantic cosine
        val queryVector = buildQueryVector(queryTerms, totalDocs)
        val semanticScores = mutableMapOf<ChunkRef, Double>()
        for ((ref, docVector) in embeddingVectors) {
            val sim = queryVector.cosine(docVector)
            if (sim > 0.05) semanticScores[ref] = sim
        }
        // hybrid merge
        val maxBm25 = scored.values.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
        val maxSem = semanticScores.values.maxOrNull()?.coerceAtLeast(1.0) ?: 1.0
        val hybrid = mutableMapOf<ChunkRef, Double>()
        for (ref in scored.keys + semanticScores.keys) {
            hybrid[ref] = 0.40 * ((scored[ref] ?: 0.0) / maxBm25) + 0.30 * ((semanticScores[ref] ?: 0.0) / maxSem)
        }
        // symbol boost
        for (ref in hybrid.keys.toList()) {
            val chunk = findChunk(ref) ?: continue
            if (chunk.symbols.any { sym -> queryTerms.any { sym.lowercase().contains(it) } }) {
                hybrid[ref] = (hybrid[ref] ?: 0.0) + 0.20
            }
        }
        // path proximity
        for (ref in hybrid.keys.toList()) {
            if (ref.path.lowercase().contains(queryLower)) hybrid[ref] = (hybrid[ref] ?: 0.0) + 0.10
        }
        return hybrid.entries
            .sortedByDescending { it.value }
            .take(topK)
            .map { (ref, score) ->
                val chunk = findChunk(ref)
                Hit(
                    path = ref.path, line = ref.startLine,
                    lineContent = chunk?.content?.lineSequence()?.firstOrNull() ?: "",
                    score = score, matchType = "hybrid",
                )
            }
    }

    /**
     * Adaptive-depth search: adjusts topK and strategy by query complexity.
     * Sunk from LocalSearchEngine.adaptiveSearch.
     */
    suspend fun adaptiveSearch(query: String): List<Hit> {
        val complexity = assessQueryComplexity(query)
        val topK = when {
            complexity.termCount <= 2 -> 10
            complexity.termCount <= 5 -> 20
            else -> 50
        }
        val results = if (complexity.isStructural) {
            semantic(query, topK).map { if (it.matchType == "symbol") it.copy(score = it.score * 1.5) else it }
        } else if (complexity.isConceptual) {
            val kw = semantic(query, topK / 2)
            val sem = semantic(query, topK / 2)
            mergeDedup(kw, sem, topK)
        } else {
            semantic(query, topK)
        }
        return results.map { it.copy(matchType = "adaptive") }
    }

    data class QueryComplexity(
        val termCount: Int, val isStructural: Boolean,
        val isConceptual: Boolean, val depth: String,
    )

    private fun assessQueryComplexity(query: String): QueryComplexity {
        val terms = tokenize(query)
        val structuralKeywords = setOf(
            "class", "interface", "enum", "object", "struct", "type", "function", "method",
            "fun", "def", "func", "fn", "variable", "field", "property", "const", "val", "var",
            "implement", "extend", "inherit", "override", "abstract", "import", "module",
            "package", "namespace",
        )
        val isStructural = terms.any { it in structuralKeywords }
        val conceptualPatterns = listOf(
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
        val depth = when {
            terms.size <= 2 -> "shallow"
            terms.size <= 5 -> "medium"
            else -> "deep"
        }
        return QueryComplexity(terms.size, isStructural, isConceptual, depth)
    }

    private fun mergeDedup(a: List<Hit>, b: List<Hit>, topK: Int): List<Hit> {
        val merged = mutableMapOf<Pair<String, Int>, Hit>()
        for (hit in a) {
            val key = hit.path to hit.line
            val ex = merged[key]
            if (ex == null || hit.score > ex.score) merged[key] = hit
        }
        for (hit in b) {
            val key = hit.path to hit.line
            val ex = merged[key]
            if (ex == null) merged[key] = hit
            else merged[key] = ex.copy(score = ex.score * 0.6 + hit.score * 0.4)
        }
        return merged.values.sortedByDescending { it.score }.take(topK)
    }

    private fun findChunk(ref: ChunkRef): IndexedChunk? =
        forwardIndex[ref.path]?.find { it.startLine == ref.startLine && it.endLine == ref.endLine }

    private fun buildQueryVector(queryTerms: List<String>, totalDocs: Double): SparseVector {
        val termFreqs = mutableMapOf<String, Int>()
        for (term in queryTerms) termFreqs[term] = (termFreqs[term] ?: 0) + 1
        val docLen = queryTerms.size.coerceAtLeast(1)
        val vecTerms = mutableMapOf<String, Double>()
        for ((term, freq) in termFreqs) {
            val tf = freq.toDouble() / docLen
            val df = invertedIndex[term]?.size?.coerceAtLeast(1) ?: 1
            val idf = Math.log(totalDocs / df.toDouble())
            vecTerms[term] = tf * idf
        }
        return SparseVector(vecTerms)
    }

    private fun updateAvgDocLen() {
        val lens = docLenMap.values
        if (lens.isNotEmpty()) avgDocLen.set(lens.average())
    }

    private fun isBinaryPath(p: Path): Boolean =
        p.fileName.toString().matches(Regex(".*\\.(jar|class|png|jpg|gif|zip|tar|gz|bin|so|dylib|pdf|onnx)$"))

    /** Tokenizer sunk verbatim from LocalSearchEngine.tokenize. */
    private fun tokenize(text: String): List<String> = text
        .replace(Regex("([a-z])([A-Z])"), "$1 $2")
        .replace(Regex("([A-Z]+)([A-Z][a-z])"), "$1 $2")
        .split(Regex("[^a-zA-Z0-9]+"))
        .map { it.lowercase() }
        .filter { it.length >= 2 }

    /** Lightweight sparse vector with cosine similarity. */
    data class SparseVector(val terms: Map<String, Double>) {
        fun cosine(other: SparseVector): Double {
            var dot = 0.0; var normA = 0.0; var normB = 0.0
            for ((term, w) in this.terms) {
                normA += w * w
                val ow = other.terms[term] ?: 0.0
                dot += w * ow; normB += ow * ow
            }
            if (normB == 0.0) for ((_, w) in other.terms) normB += w * w
            val denom = Math.sqrt(normA) * Math.sqrt(normB)
            return if (denom > 0) dot / denom else 0.0
        }
    }
}
