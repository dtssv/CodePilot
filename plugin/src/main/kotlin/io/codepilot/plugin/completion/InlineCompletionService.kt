package io.codepilot.plugin.completion

import io.codepilot.plugin.transport.HttpClientService
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference
import okhttp3.Call

/**
 * Enhanced inline-completion client with:
 * - FIM (Fill-in-the-Middle) support
 * - Multi-candidate ranking
 * - Request caching (same prefix → reuse result)
 * - Request cancellation (new keystroke cancels pending request)
 * - File outline context for better suggestions
 */
object InlineCompletionService {

    /** Maximum number of cached completion results. */
    private const val CACHE_MAX_SIZE = 50

    /** Cache: (prefix hash) → CompletionResult */
    private val cache = object : LinkedHashMap<String, CompletionResult>(CACHE_MAX_SIZE, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CompletionResult>): Boolean {
            return size > CACHE_MAX_SIZE
        }
    }

    /** Currently in-flight HTTP call — cancelled when a new request arrives. */
    private val pendingCall = AtomicReference<Call?>(null)

    data class CompletionRequest(
        val prefix: String,
        val suffix: String,
        val language: String,
        val filePath: String,
        val fileOutline: String? = null,
        val maxCandidates: Int = 3,
        val maxTokens: Int = 128,
        val temperature: Float = 0.2f,
    )

    data class CompletionResult(
        val candidates: List<String>,
        val selectedIndex: Int = 0,
        val timestamp: Long = System.currentTimeMillis(),
    ) {
        val primary: String? get() = candidates.getOrNull(selectedIndex)
    }

    /**
     * Request completion. Cancels any pending request first.
     * Returns the best candidate, or null if no completion available.
     */
    fun complete(request: CompletionRequest): String? {
        // Cancel any in-flight request
        cancelPending()

        // Check cache first
        val cacheKey = computeCacheKey(request)
        synchronized(cache) {
            cache[cacheKey]?.let { cached ->
                // Cache hit valid for 10 seconds
                if (System.currentTimeMillis() - cached.timestamp < 10_000) {
                    return cached.primary
                }
                cache.remove(cacheKey)
            }
        }

        val http = HttpClientService.getInstance()
        val payload = buildPayload(request)
        val httpReq = http.postJson("/v1/actions/inline-completion", payload)

        return try {
            val call = http.client().newCall(httpReq)
            pendingCall.set(call)

            val response = call.execute()
            pendingCall.compareAndSet(call, null)

            response.use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                val candidates = parseCompletionResponse(body)

                if (candidates.isNotEmpty()) {
                    val result = CompletionResult(candidates = candidates)
                    synchronized(cache) {
                        cache[cacheKey] = result
                    }
                    result.primary
                } else null
            }
        } catch (_: IOException) {
            null
        }
    }

    /** Cancel any pending completion request. Called on new keystrokes. */
    fun cancelPending() {
        pendingCall.getAndSet(null)?.cancel()
    }

    /** Clear the completion cache. */
    fun clearCache() {
        synchronized(cache) { cache.clear() }
    }

    // ─── Internal ───────────────────────────────────────────────────

    private fun buildPayload(request: CompletionRequest): Map<String, Any?> {
        return mapOf(
            "sessionId" to UUID.randomUUID().toString(),
            "prefix" to request.prefix,
            "suffix" to request.suffix,
            "language" to request.language,
            "filePath" to request.filePath,
            "fileOutline" to request.fileOutline,
            "maxCandidates" to request.maxCandidates,
            "maxTokens" to request.maxTokens,
            "temperature" to request.temperature,
            // Signal FIM mode to the backend
            "mode" to "fim",
        )
    }

    /**
     * Parse SSE response. Supports both:
     * - Multi-candidate: data:{"candidates":["...", "..."]}
     * - Single-candidate: data:{"text":"..."}
     */
    private fun parseCompletionResponse(sseBody: String): List<String> {
        val candidates = mutableListOf<String>()
        val singleBuilder = StringBuilder()

        for (line in sseBody.lines()) {
            if (!line.startsWith("data:")) continue
            val data = line.removePrefix("data:").trim()
            if (data == "[DONE]") break

            // Try multi-candidate format first
            val candidatesMatch = Regex(""""candidates"\s*:\s*\[([^\]]+)\]""").find(data)
            if (candidatesMatch != null) {
                val raw = candidatesMatch.groupValues[1]
                Regex(""""((?:[^"\\]|\\.)*)"""").findAll(raw).forEach { m ->
                    candidates.add(unescapeJson(m.groupValues[1]))
                }
                return candidates
            }

            // Single text delta
            val textMatch = Regex(""""text"\s*:\s*"((?:[^"\\]|\\.)*)"?""").find(data)
            if (textMatch != null) {
                singleBuilder.append(unescapeJson(textMatch.groupValues[1]))
            }
        }

        val text = singleBuilder.toString().trim()
        if (text.isNotEmpty()) candidates.add(text)
        return candidates
    }

    private fun unescapeJson(s: String): String = s
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")

    private fun computeCacheKey(request: CompletionRequest): String {
        // Use last 200 chars of prefix + first 100 chars of suffix as cache key
        val prefixTail = request.prefix.takeLast(200)
        val suffixHead = request.suffix.take(100)
        return "${request.filePath}:${prefixTail.hashCode()}:${suffixHead.hashCode()}"
    }
}