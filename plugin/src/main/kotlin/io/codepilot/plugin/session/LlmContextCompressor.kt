package io.codepilot.plugin.session

import com.fasterxml.jackson.databind.ObjectMapper
import io.codepilot.plugin.transport.HttpClientService
import java.util.concurrent.ConcurrentHashMap

/**
 * LLM-powered Context Compression.
 *
 * Uses a lightweight LLM call to compress conversation history into
 * a concise summary that preserves key information, decisions, and
 * code context. Replaces the heuristic-only LocalDigestService for
 * cases where higher compression quality is needed.
 *
 * Strategy:
 * - For messages exceeding the compression threshold, invoke LLM to summarize
 * - Preserves: code snippets, error messages, decisions, action items
 * - Removes: pleasantries, redundant explanations, verbose context
 * - Cost control: Only compresses when budget savings > cost of compression call
 *
 * Integration with ContextBudgeter:
 * - Stage 5 (Digest): Try LLM compression first, fall back to LocalDigestService
 * - Compression is triggered when context exceeds 80% of budget
 */
object LlmContextCompressor {

    private val mapper = ObjectMapper()

    data class CompressionRequest(
        val messages: List<Map<String, Any>>,
        val targetTokens: Int,
        val modelId: String? = null,
        val preserveCodeBlocks: Boolean = true,
        val preserveDecisions: Boolean = true,
    )

    data class CompressionResult(
        val summary: String,
        val originalTokens: Int,
        val compressedTokens: Int,
        val compressionRatio: Double,
        val method: String, // "llm" | "heuristic" | "none"
        val preservedItems: List<String>, // Types of items preserved
    )

    // Cache: message hash → compressed result (avoids recompression)
    private val compressionCache = ConcurrentHashMap<String, CompressionResult>()
    private const val CACHE_MAX = 50

    // Minimum savings required to justify an LLM call (in tokens)
    private const val MIN_SAVINGS_THRESHOLD = 200

    /**
     * Compress a list of messages using LLM summarization.
     * Falls back to heuristic compression if LLM is unavailable or not cost-effective.
     */
    fun compress(request: CompressionRequest): CompressionResult {
        // Check cache
        val cacheKey = computeCacheKey(request)
        compressionCache[cacheKey]?.let { return it }

        // Estimate current token count
        val originalTokens = estimateTokens(request.messages)
        if (originalTokens <= request.targetTokens) {
            return CompressionResult("", originalTokens, originalTokens, 1.0, "none", emptyList())
        }

        // Check if LLM compression is cost-effective
        val potentialSavings = originalTokens - request.targetTokens
        if (potentialSavings < MIN_SAVINGS_THRESHOLD) {
            return heuristicCompress(request)
        }

        // Try LLM compression
        return try {
            val result = llmCompress(request)
            // Cache the result
            if (compressionCache.size >= CACHE_MAX) {
                compressionCache.clear()
            }
            compressionCache[cacheKey] = result
            result
        } catch (_: Exception) {
            heuristicCompress(request)
        }
    }

    // ─── LLM Compression ───────────────────────────────────────────────

    private fun llmCompress(request: CompressionRequest): CompressionResult {
        val originalTokens = estimateTokens(request.messages)

        // Build compression prompt
        val messagesText = formatMessagesForCompression(request.messages)
        val preserveInstructions = buildPreserveInstructions(request)

        val prompt = """
You are a conversation compressor. Summarize the following conversation history into a concise summary.

Rules:
1. Preserve ALL code snippets exactly (in ```code blocks```)
2. Preserve ALL error messages and their resolutions
3. Preserve ALL decisions and action items
4. Preserve file paths and method names mentioned
5. Remove pleasantries, greetings, and redundant explanations
6. Keep the summary under ${request.targetTokens} tokens
$preserveInstructions

Conversation to compress:
$messagesText

Compressed summary:
""".trimIndent()

        // Call LLM for compression
        val http = HttpClientService.getInstance()
        val payload = mapOf(
            "sessionId" to "compression-${System.currentTimeMillis()}",
            "mode" to "chat",
            "modelId" to (request.modelId ?: ""),
            "input" to prompt,
            "maxTokens" to request.targetTokens,
        )

        val httpRequest = http.postJson("/v1/actions/inline-completion", payload)
        val response = http.client().newCall(httpRequest).execute()

        val summary = response.use { resp ->
            if (!resp.isSuccessful) return heuristicCompress(request)
            val body = resp.body?.string() ?: return heuristicCompress(request)
            // Parse the SSE response to get the text
            parseSseText(body)
        }

        val compressedTokens = estimateTokensFromString(summary)
        return CompressionResult(
            summary = summary,
            originalTokens = originalTokens,
            compressedTokens = compressedTokens,
            compressionRatio = if (originalTokens > 0) compressedTokens.toDouble() / originalTokens else 1.0,
            method = "llm",
            preservedItems = listOf("code", "errors", "decisions", "paths"),
        )
    }

    // ─── Heuristic Compression (Fallback) ──────────────────────────────

    private fun heuristicCompress(request: CompressionRequest): CompressionResult {
        val originalTokens = estimateTokens(request.messages)
        val compressed = com.intellij.openapi.components.service<LocalDigestService>().foldToBudget(request.messages, request.targetTokens)
        val summary = compressed.first.map { msg ->
            "${msg["role"]}: ${msg["content"]}"
        }.joinToString("\n")

        val compressedTokens = estimateTokensFromString(summary)
        return CompressionResult(
            summary = summary,
            originalTokens = originalTokens,
            compressedTokens = compressedTokens,
            compressionRatio = if (originalTokens > 0) compressedTokens.toDouble() / originalTokens else 1.0,
            method = "heuristic",
            preservedItems = listOf("code_blocks", "status_lines"),
        )
    }

    // ─── Utility ───────────────────────────────────────────────────────

    private fun formatMessagesForCompression(messages: List<Map<String, Any>>): String {
        return messages.takeLast(20).map { msg ->
            val role = msg["role"] ?: "unknown"
            val content = msg["content"]?.toString() ?: ""
            "[$role]: ${content.take(500)}"
        }.joinToString("\n\n")
    }

    private fun buildPreserveInstructions(request: CompressionRequest): String {
        val instructions = mutableListOf<String>()
        if (request.preserveCodeBlocks) instructions.add("- Preserve ALL code blocks verbatim")
        if (request.preserveDecisions) instructions.add("- Preserve ALL decisions and their rationale")
        return instructions.joinToString("\n")
    }

    private fun computeCacheKey(request: CompressionRequest): String {
        val content = request.messages.map { it["content"].toString() }.joinToString("|")
        return "${content.hashCode()}:${request.targetTokens}"
    }

    private fun estimateTokens(messages: List<Map<String, Any>>): Int {
        return messages.sumOf { estimateTokensFromString(it["content"]?.toString() ?: "") }
    }

    private fun estimateTokensFromString(text: String): Int {
        // Use TokenEstimator if available, otherwise heuristic
        return try {
            io.codepilot.plugin.session.TokenEstimator.countTokens(text)
        } catch (_: Exception) {
            // Heuristic: ~3.5 chars per token for English, ~2 for CJK
            val cjkCount = text.count { it.code > 0x2E80 }
            val otherCount = text.length - cjkCount
            (cjkCount / 2 + otherCount / 4).coerceAtLeast(1)
        }
    }

    private fun parseSseText(sseBody: String): String {
        val builder = StringBuilder()
        for (line in sseBody.lines()) {
            if (!line.startsWith("data:")) continue
            val data = line.removePrefix("data:").trim()
            if (data == "[DONE]") break
            val textMatch = Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"?").find(data)
            if (textMatch != null) {
                builder.append(textMatch.groupValues[1])
            }
        }
        return builder.toString().trim()
    }
}