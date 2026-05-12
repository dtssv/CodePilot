package io.codepilot.plugin.session

import com.intellij.openapi.diagnostic.logger

/**
 * Accurate token estimation using jtokkit (OpenAI BPE tokenizer).
 * Falls back to a character-based heuristic when jtokkit is unavailable.
 *
 * Tokenization strategy:
 * - Primary: jtokkit EncodingRegistry for cl100k_base (GPT-4/Claude-compatible)
 * - Fallback: ~3.5 chars/token for English, ~2 chars/token for CJK
 */
object TokenEstimator {

    private val log = logger<TokenEstimator>()

    private val encoderLazy: Any? by lazy {
        try {
            val registryClass = Class.forName("com.knuddels.jtokkit.Encodings")
            val registry = registryClass.getMethod("newLazyEncodingRegistry").invoke(null)
            val encodingType = Class.forName("com.knuddels.jtokkit.EncodingType")
                .getDeclaredField("CL100K_BASE")
                .get(null)
            registryClass.getMethod("getEncoding", encodingType.javaClass)
                .invoke(registry, encodingType)
        } catch (e: Exception) {
            log.info("jtokkit not available on classpath, using character-based token estimation")
            null
        }
    }

    /**
     * Count tokens in the given text.
     * Uses jtokkit for accurate BPE tokenization if available,
     * otherwise falls back to a heuristic.
     */
    fun countTokens(text: String): Int {
        if (text.isEmpty()) return 0

        encoderLazy?.let { encoder ->
            return try {
                val encodeMethod = encoder.javaClass.getMethod("encode", String::class.java)
                val result = encodeMethod.invoke(encoder, text)
                val sizeMethod = result.javaClass.getMethod("size")
                sizeMethod.invoke(result) as Int
            } catch (e: Exception) {
                log.debug("jtokkit encode failed, falling back to heuristic", e)
                heuristicCount(text)
            }
        }

        return heuristicCount(text)
    }

    /**
     * Count tokens for multiple messages (role + content pairs).
     * Adds overhead per message (~4 tokens for role/separator formatting).
     */
    fun countMessages(messages: List<Map<String, Any>>): Int {
        var total = 0
        for (msg in messages) {
            val role = msg["role"] as? String ?: ""
            val content = msg["content"] as? String ?: ""
            total += countTokens(role) + countTokens(content) + 4
        }
        total += 2
        return total
    }

    /**
     * Heuristic token count: ~3.5 chars/token for English, ~2 chars/token for CJK.
     */
    private fun heuristicCount(text: String): Int {
        var cjkCount = 0
        var asciiCount = 0
        for (ch in text) {
            if (isCJK(ch)) {
                cjkCount++
            } else {
                asciiCount++
            }
        }
        return (cjkCount / 2.0 + asciiCount / 3.5).toInt().coerceAtLeast(1)
    }

    private fun isCJK(ch: Char): Boolean {
        val code = ch.code
        return code in 0x4E00..0x9FFF ||
                code in 0x3400..0x4DBF ||
                code in 0x3000..0x303F ||
                code in 0x3040..0x309F ||
                code in 0x30A0..0x30FF ||
                code in 0xAC00..0xD7AF
    }

    fun isJtokkitAvailable(): Boolean = encoderLazy != null
}