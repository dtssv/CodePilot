package io.codepilot.harness.search

/**
 * Embedder SPI: produce a fixed-dimension float vector for a text.
 *
 * Implementations (in order of preference at runtime):
 *   1. [PythonEmbedder]   — sentence-transformers subprocess (best quality)
 *   2. [OnnxSubprocessEmbedder] — ONNX runtime via subprocess (when python+onnxruntime present)
 *   3. [TfidfEmbedder]    — pure-JDK TF-IDF + charNgram hash fallback (always available)
 *
 * The harness loop never picks — it asks the configured [Embedder] for an
 * embedding and the implementation decides whether to delegate to a subprocess
 * or compute locally.
 */
interface Embedder {
    val name: String
    val dimension: Int
    suspend fun embed(text: String): FloatArray
}

/**
 * Pure-JDK TF-IDF + char-ngram hash embedder.
 *
 * Sunk from plugin/indexer/LocalEmbeddingService.kt's TF-IDF / hashEmbed path
 * (the ONNX reflection path was never wired up — see plan §"子进程机会").
 *
 * This is the fallback when no Python/ONNX runtime is available. It produces a
 * fixed-dimension vector via the hashing trick on character n-grams, so it's
 * always available and deterministic. Quality is lower than a transformer but
 * sufficient for hybrid BM25+cosine search.
 */
class TfidfEmbedder(override val dimension: Int = 256) : Embedder {
    override val name = "tfidf-hash"

    override suspend fun embed(text: String): FloatArray {
        val vec = FloatArray(dimension)
        val ngrams = charNgrams(text, minN = 3, maxN = 5)
        for (ng in ngrams) {
            val h = hash(ng) % dimension
            vec[h] = vec[h] + 1.0f
        }
        // L2 normalize
        var norm = 0.0f
        for (v in vec) norm += v * v
        norm = Math.sqrt(norm.toDouble()).toFloat()
        if (norm > 0) for (i in vec.indices) vec[i] /= norm
        return vec
    }

    private fun charNgrams(text: String, minN: Int, maxN: Int): List<String> {
        val cleaned = text.lowercase().filter { it.isLetterOrDigit() || it.isWhitespace() }
        val out = mutableListOf<String>()
        for (n in minN..maxN) {
            for (i in 0..cleaned.length - n) {
                out.add(cleaned.substring(i, i + n))
            }
        }
        return out
    }

    private fun hash(s: String): Int {
        var h = 0
        for (c in s) h = 31 * h + c.code
        return h and 0x7fffffff
    }
}

/**
 * Cosine similarity for dense float vectors (used by [PythonEmbedder] results).
 */
fun cosine(a: FloatArray, b: FloatArray): Double {
    if (a.size != b.size) return 0.0
    var dot = 0.0; var na = 0.0; var nb = 0.0
    for (i in a.indices) {
        dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
    }
    val denom = Math.sqrt(na) * Math.sqrt(nb)
    return if (denom > 0) dot / denom else 0.0
}
