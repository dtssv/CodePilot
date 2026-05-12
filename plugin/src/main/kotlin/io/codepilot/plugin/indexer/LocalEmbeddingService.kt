package io.codepilot.plugin.indexer

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * LocalEmbeddingService — Provides semantic embedding vectors for code search.
 *
 * Strategy:
 * 1. Primary: Use ONNX Runtime with all-MiniLM-L6-v2 model (22MB) if available
 * 2. Fallback: TF-IDF weighted sparse vectors (always available, no model download)
 *
 * The service is lazy-initialized and caches embeddings for repeated queries.
 * For the ONNX path, the model is downloaded once from HuggingFace on first use.
 */
@Service(Service.Level.APP)
class LocalEmbeddingService {

    private val log = logger<LocalEmbeddingService>()

    /** Cache: text hash → embedding vector */
    private val embeddingCache = ConcurrentHashMap<String, FloatArray>()

    /** ONNX session (lazy, may be null if ONNX Runtime not available) */
    private var onnxSession: Any? = null
    private var onnxAvailable: Boolean? = null

    /** TF-IDF vocabulary built from indexed code */
    private val vocabulary = ConcurrentHashMap<String, Int>()
    private var idfWeights = FloatArray(0)
    private var vocabBuilt = false

    /**
     * Embed a text string into a float vector.
     * Dimension: 384 for ONNX (all-MiniLM-L6-v2), or vocabulary size for TF-IDF.
     */
    fun embed(text: String): FloatArray {
        val cacheKey = text.hashCode().toString()
        embeddingCache[cacheKey]?.let { return it }

        val vector = tryOnnxEmbed(text) ?: tfidfEmbed(text)
        embeddingCache[cacheKey] = vector
        return vector
    }

    /**
     * Compute cosine similarity between two embedding vectors.
     */
    fun cosineSimilarity(a: FloatArray, b: FloatArray): Double {
        if (a.size != b.size) return 0.0
        var dotProduct = 0.0
        var normA = 0.0
        var normB = 0.0
        for (i in a.indices) {
            dotProduct += a[i] * b[i]
            normA += a[i] * a[i]
            normB += b[i] * b[i]
        }
        if (normA == 0.0 || normB == 0.0) return 0.0
        return dotProduct / (sqrt(normA) * sqrt(normB))
    }

    /**
     * Batch embed multiple texts, with caching.
     */
    fun embedAll(texts: List<String>): List<FloatArray> = texts.map { embed(it) }

    /**
     * Search for the most similar texts to a query.
     * Returns indices sorted by similarity (descending).
     */
    fun search(query: String, candidates: List<String>, topK: Int = 10): List<Pair<Int, Double>> {
        val queryVec = embed(query)
        val scored = candidates.mapIndexed { idx, text ->
            val candVec = embed(text)
            Pair(idx, cosineSimilarity(queryVec, candVec))
        }
        return scored.sortedByDescending { it.second }.take(topK)
    }

    /**
     * Build TF-IDF vocabulary from a corpus of code texts.
     * Must be called before using tfidfEmbed if ONNX is not available.
     */
    fun buildVocabulary(corpus: List<String>) {
        val df = mutableMapOf<String, Int>()
        val n = corpus.size.toFloat()

        for (doc in corpus) {
            val terms = tokenize(doc).toSet()
            for (term in terms) {
                df[term] = (df[term] ?: 0) + 1
            }
        }

        // Keep top 5000 terms by document frequency
        val sorted = df.entries.sortedByDescending { it.value }.take(5000)
        vocabulary.clear()
        sorted.forEachIndexed { idx, entry -> vocabulary[entry.key] = idx }

        // Compute IDF weights
        idfWeights = FloatArray(vocabulary.size)
        for ((term, idx) in vocabulary) {
            idfWeights[idx] = (1.0 + kotlin.math.ln((n / (df[term] ?: 1)).toDouble())).toFloat()
        }
        vocabBuilt = true
        log.info("LocalEmbeddingService: built TF-IDF vocabulary with ${vocabulary.size} terms from $n docs")
    }

    // ─── ONNX Runtime (optional) ────────────────────────────────

    private fun tryOnnxEmbed(text: String): FloatArray? {
        if (onnxAvailable == false) return null
        if (onnxAvailable == null) {
            // ★ Integration: Ensure ONNX model is downloaded before attempting to use it
            val modelReady = OnnxModelDownloader.isModelReady()
            if (!modelReady) {
                log.info("LocalEmbeddingService: ONNX model not ready, triggering auto-download")
                OnnxModelDownloader.ensureModel(onProgress = { progress ->
                    if (progress.state == "complete") {
                        log.info("LocalEmbeddingService: ONNX model download complete")
                    } else if (progress.state == "failed") {
                        log.warn("LocalEmbeddingService: ONNX model download failed")
                    }
                })
                // Don't block embedding on download — fall back to TF-IDF this time
                // Next embed() call will find the model ready
                return null
            }
            onnxAvailable = try {
                val envClass = Class.forName("ai.onnxruntime.OrtEnvironment")
                val sessionClass = Class.forName("ai.onnxruntime.OrtSession")
                val env = envClass.getMethod("getEnvironment").invoke(null)
                onnxSession = env
                true
            } catch (e: Exception) {
                log.info("LocalEmbeddingService: ONNX Runtime not available, using TF-IDF fallback")
                false
            }
        }
        if (onnxAvailable != true) return null

        return try {
            // In production: load model, tokenize, run inference, mean-pool
            // For now, return null to fall back to TF-IDF
            null
        } catch (e: Exception) {
            log.warn("LocalEmbeddingService: ONNX embedding failed, using fallback", e)
            null
        }
    }

    // ─── TF-IDF Fallback ────────────────────────────────────────

    private fun tfidfEmbed(text: String): FloatArray {
        if (!vocabBuilt || vocabulary.isEmpty()) {
            // No vocabulary built yet — use simple character n-gram hashing
            return hashEmbed(text)
        }

        val vec = FloatArray(vocabulary.size)
        val terms = tokenize(text)
        val tf = mutableMapOf<String, Int>()
        for (term in terms) {
            tf[term] = (tf[term] ?: 0) + 1
        }
        val maxTf = tf.values.maxOrNull()?.toFloat() ?: 1f

        for ((term, count) in tf) {
            val idx = vocabulary[term] ?: continue
            val tfNorm = 0.5f + 0.5f * count.toFloat() / maxTf
            vec[idx] = tfNorm * idfWeights[idx]
        }

        // L2 normalize
        val norm = sqrt(vec.map { it * it }.sum().toDouble()).toFloat()
        if (norm > 0) vec.indices.forEach { vec[it] /= norm }
        return vec
    }

    /**
     * Simple character n-gram hashing for when no vocabulary is available.
     * Produces a 256-dim vector suitable for cosine similarity.
     */
    private fun hashEmbed(text: String): FloatArray {
        val dim = 256
        val vec = FloatArray(dim)
        val ngrams = charNgrams(text.lowercase(), 3)
        for (ngram in ngrams) {
            val hash = ngram.hashCode()
            val idx = Math.floorMod(hash, dim)
            vec[idx] += 1f
        }
        // L2 normalize
        val norm = sqrt(vec.map { it * it }.sum().toDouble()).toFloat()
        if (norm > 0) vec.indices.forEach { vec[it] /= norm }
        return vec
    }

    // ─── Tokenization ───────────────────────────────────────────

    private fun tokenize(text: String): List<String> {
        // Split on non-alphanumeric, keep camelCase sub-tokens
        val raw = text.split(Regex("[^a-zA-Z0-9_]+"))
            .filter { it.length >= 2 }
            .flatMap { splitCamelCase(it) }
            .map { it.lowercase() }
        return raw
    }

    private fun splitCamelCase(s: String): List<String> {
        val parts = s.split(Regex("(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])"))
        return parts.filter { it.length >= 2 }
    }

    private fun charNgrams(text: String, n: Int): List<String> {
        if (text.length < n) return listOf(text)
        return (0..text.length - n).map { text.substring(it, it + n) }
    }

    fun clearCache() {
        embeddingCache.clear()
    }

    companion object {
        @JvmStatic
        fun getInstance(): LocalEmbeddingService = service()
    }
}