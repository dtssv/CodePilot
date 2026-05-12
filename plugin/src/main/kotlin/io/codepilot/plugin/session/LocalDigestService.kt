package io.codepilot.plugin.session

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import io.codepilot.plugin.session.TokenEstimator.countTokens

/**
 * LocalDigestService — Client-side message folding/compression.
 *
 * When a conversation exceeds the token budget, older messages are folded
 * into a local digest summary, reducing context size without server round-trip.
 *
 * Unlike server-side digest (which replaces messages with a LLM-generated summary),
 * local digest uses heuristic folding:
 * - User messages: keep first 100 chars + "... (folded N chars)"
 * - Assistant messages: keep code blocks + first 200 chars of prose
 * - Tool results: keep status line only (ok/fail + summary)
 * - System messages: always keep in full
 *
 * The digest is computed locally, avoiding an extra LLM call.
 */
@Service(Service.Level.APP)
class LocalDigestService {

    private val log = logger<LocalDigestService>()
    private val mapper = jacksonObjectMapper()

    data class FoldedMessage(
        val original: Map<String, Any>,
        val foldedContent: String,
        val originalTokenCount: Int,
        val foldedTokenCount: Int,
    )

    /**
     * Fold messages that exceed the token budget, keeping the most recent
     * messages intact and compressing older ones.
     *
     * @param messages All messages in the conversation
     * @param budgetTokens Maximum tokens to allocate for messages
     * @return Pair of (folded messages, list of fold records for audit)
     */
    fun foldToBudget(
        messages: List<Map<String, Any>>,
        budgetTokens: Int,
    ): Pair<List<Map<String, Any>>, List<FoldedMessage>> {
        val folds = mutableListOf<FoldedMessage>()

        // Calculate total tokens
        var totalTokens = messages.sumOf { countTokens(it["content"] as? String ?: "") }

        if (totalTokens <= budgetTokens) return Pair(messages, emptyList())

        // Strategy: fold oldest messages first, keep last N messages intact
        val keepRecent = 6 // Always keep last 6 messages intact
        val safeMessages = messages.takeLast(keepRecent)
        val foldableMessages = messages.dropLast(keepRecent)

        val safeTokens = safeMessages.sumOf { countTokens(it["content"] as? String ?: "") }
        val foldBudget = budgetTokens - safeTokens

        val foldedMessages = mutableListOf<Map<String, Any>>()
        var usedTokens = 0

        for (msg in foldableMessages) {
            val content = msg["content"] as? String ?: ""
            val role = msg["role"] as? String ?: "user"
            val tokenCount = countTokens(content)

            if (usedTokens + tokenCount <= foldBudget) {
                // Fits within budget, keep as-is
                foldedMessages.add(msg)
                usedTokens += tokenCount
            } else {
                // Need to fold
                val maxTokens = (foldBudget - usedTokens).coerceAtLeast(0)
                val folded = foldMessage(role, content, maxTokens)
                if (folded != null) {
                    val foldedMap = msg.toMutableMap()
                    foldedMap["content"] = folded
                    foldedMap["_folded"] = true
                    foldedMap["_originalTokens"] = tokenCount
                    foldedMessages.add(foldedMap)
                    folds.add(FoldedMessage(msg, folded, tokenCount, countTokens(folded)))
                    usedTokens += countTokens(folded)
                }
                // If no budget left, skip remaining messages
                if (usedTokens >= foldBudget) break
            }
        }

        val result = foldedMessages + safeMessages
        log.info("LocalDigest: folded ${folds.size} messages, tokens $totalTokens → ${usedTokens + safeTokens}")
        return Pair(result, folds)
    }

    private fun foldMessage(role: String, content: String, maxTokens: Int): String? {
        if (maxTokens <= 0) return null
        val maxChars = (maxTokens * 3.5).toInt().coerceAtLeast(50)

        return when (role) {
            "system" -> content.take(maxChars) + if (content.length > maxChars) "\n... (folded)" else ""
            "user" -> content.take(100) + if (content.length > 100) "\n... (folded ${content.length - 100} chars)" else ""
            "assistant" -> {
                // Keep code blocks, compress prose
                val codeBlocks = extractCodeBlocks(content)
                val prose = content.take(200)
                val summary = prose + if (content.length > 200) "\n... (prose folded)" else ""
                if (codeBlocks.isNotEmpty()) "$summary\n\n$codeBlocks" else summary
            }
            "tool" -> {
                // Keep first line (usually status) + error info
                val firstLine = content.lines().firstOrNull() ?: ""
                val errorLine = content.lines().find { it.contains("error", ignoreCase = true) }
                if (errorLine != null) "$firstLine\n$errorLine" else firstLine
            }
            else -> content.take(maxChars)
        }
    }

    private fun extractCodeBlocks(content: String): String {
        val regex = Regex("```[\\s\\S]*?```")
        return regex.findAll(content).joinToString("\n\n") { it.value }
    }

    companion object {
        @JvmStatic
        fun getInstance(): LocalDigestService = service()
    }
}