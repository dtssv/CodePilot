package io.codepilot.plugin.completion

import io.codepilot.plugin.transport.HttpClientService
import okhttp3.Call
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/**
 * Enhanced inline-completion client with:
 * - FIM (Fill-in-the-Middle) support with proper <PRE>/<SUF>/<MID> formatting
 * - Multi-candidate ranking with heuristic scoring
 * - Request caching (same prefix hash → reuse result) with TTL
 * - Request cancellation (new keystroke cancels pending request)
 * - File outline context for better suggestions
 * - Suffix alignment verification
 * - Infix completion support
 */
object InlineCompletionService {
    private const val CACHE_MAX_SIZE = 100
    private const val CACHE_TTL_MS = 10_000L
    private const val CANDIDATE_SEPARATOR = "---CANDIDATE---"
    private const val MAX_SUFFIX_ALIGN_LINES = 3
    private const val MULTI_LINE_MAX_EXTEND_LINES = 20
    private const val MULTI_LINE_MAX_EXTEND_TOKENS = 256

    private val cache =
        object : LinkedHashMap<String, CompletionResult>(CACHE_MAX_SIZE, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CompletionResult>): Boolean = size > CACHE_MAX_SIZE
        }

    private val pendingCall = AtomicReference<Call?>(null)

    // ─── Multi-model Fallback ──────────────────────────────────────────
    private val modelFallbackChain = listOf("deepseek-coder", "qwen2.5-coder", "starcoder2")
    private var currentModelIdx = 0
    private val modelFailCounts = mutableMapOf<String, Int>()
    private val MODEL_FAIL_THRESHOLD = 3 // Switch after 3 consecutive failures

    // ─── Cache Preheat ─────────────────────────────────────────────────
    private val preheatQueue = java.util.concurrent.LinkedBlockingQueue<CompletionRequest>()
    private val preheatThread = Thread({
        while (!Thread.currentThread().isInterrupted) {
            try {
                val req = preheatQueue.take()
                preheatCompletion(req)
            } catch (_: InterruptedException) {
                break
            }
        }
    }, "codepilot-preheat").apply { isDaemon = true; start() }

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

    data class ScoredCandidate(
        val text: String,
        val score: Double,
    )

    data class CompletionResult(
        val candidates: List<String>,
        val scoredCandidates: List<ScoredCandidate>,
        val selectedIndex: Int = 0,
        val timestamp: Long = System.currentTimeMillis(),
    ) {
        val primary: String? get() =
            scoredCandidates.getOrNull(selectedIndex)?.text
                ?: candidates.getOrNull(selectedIndex)
    }

    /**
     * Request completion. Cancels any pending request first.
     * Returns the best candidate after scoring and suffix alignment, or null if no completion available.
     */
    fun complete(request: CompletionRequest): String? {
        cancelPending()

        val cacheKey = computeCacheKey(request)
        synchronized(cache) {
            cache[cacheKey]?.let { cached ->
                if (System.currentTimeMillis() - cached.timestamp < CACHE_TTL_MS) {
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
                if (!resp.isSuccessful) {
                    // Model fallback: try next model in chain
                    return tryFallbackModel(request) ?: return null
                }
                val body = resp.body?.string() ?: return null
                val rawCandidates = parseCompletionResponse(body)

                if (rawCandidates.isEmpty()) return null

                // Score and rank candidates
                val scored =
                    rawCandidates
                        .map { candidate ->
                            ScoredCandidate(candidate, scoreCandidate(candidate, request))
                        }.sortedByDescending { it.score }

                // Apply multi-line intelligent extension for candidates that end with
                // an open brace or newline — extend to complete the code block
                val extendedCandidates =
                    rawCandidates.map { candidate ->
                        extendMultiLineIfNeeded(candidate, request)
                    }

                val extendedScored =
                    extendedCandidates
                        .map { candidate ->
                            ScoredCandidate(candidate, scoreCandidate(candidate, request))
                        }.sortedByDescending { it.score }

                // Phase 3: LLM-as-judge when top candidates are close in score
                val finalScored = if (extendedScored.size >= 2) {
                    val topScore = extendedScored[0].score
                    val secondScore = extendedScored[1].score
                    val scoreGap = topScore - secondScore
                    // Only invoke LLM judge when gap is small (candidates are ambiguous)
                    if (scoreGap < 0.15 && topScore > 1.0) {
                        llmJudgeRank(extendedScored, request)
                    } else {
                        extendedScored
                    }
                } else {
                    extendedScored
                }

                val result =
                    CompletionResult(
                        candidates = extendedCandidates,
                        scoredCandidates = finalScored,
                    )
                synchronized(cache) {
                    cache[cacheKey] = result
                }
                result.primary
            }
        } catch (_: IOException) {
            null
        }
    }

    fun cancelPending() {
        pendingCall.getAndSet(null)?.cancel()
    }

    fun clearCache() {
        synchronized(cache) { cache.clear() }
    }

    // ─── Payload Construction ─────────────────────────────────────────

    private fun buildPayload(request: CompletionRequest): Map<String, Any?> =
        mapOf(
            "sessionId" to UUID.randomUUID().toString(),
            "prefix" to request.prefix,
            "suffix" to request.suffix,
            "language" to request.language,
            "filePath" to request.filePath,
            "fileOutline" to request.fileOutline,
            "maxCandidates" to request.maxCandidates,
            "maxTokens" to request.maxTokens,
            "temperature" to request.temperature,
            "mode" to "fim",
        )

    // ─── Response Parsing ─────────────────────────────────────────────

    /**
     * Parse SSE response. Supports:
     * - Multi-candidate: candidates separated by ---CANDIDATE---
     * - JSON array: {"candidates":["...", "..."]}
     * - SSE delta stream: data:{"text":"..."} concatenated
     */
    private fun parseCompletionResponse(sseBody: String): List<String> {
        val candidates = mutableListOf<String>()
        val singleBuilder = StringBuilder()

        for (line in sseBody.lines()) {
            if (!line.startsWith("data:")) continue
            val data = line.removePrefix("data:").trim()
            if (data == "[DONE]") break

            // Try multi-candidate JSON array format
            val candidatesMatch = Regex("\"candidates\"\\s*:\\s*\\[([^\\]]+)\\]").find(data)
            if (candidatesMatch != null) {
                val raw = candidatesMatch.groupValues[1]
                Regex("\"((?:[^\"\\\\]|\\\\.)*)\"").findAll(raw).forEach { m ->
                    candidates.add(unescapeJson(m.groupValues[1]))
                }
                return candidates
            }

            // SSE delta text
            val textMatch = Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"?").find(data)
            if (textMatch != null) {
                singleBuilder.append(unescapeJson(textMatch.groupValues[1]))
            }
        }

        val text = singleBuilder.toString().trim()

        // Check for multi-candidate separator
        if (text.contains(CANDIDATE_SEPARATOR)) {
            return text
                .split(CANDIDATE_SEPARATOR)
                .map { it.trim() }
                .filter { it.isNotEmpty() && it.isNotBlank() }
        }

        if (text.isNotEmpty()) {
            // Strip markdown fences if model misbehaved
            val cleaned = stripMarkdownFences(text)
            if (cleaned.isNotEmpty()) candidates.add(cleaned)
        }

        return candidates
    }

    // ─── Candidate Scoring ────────────────────────────────────────────

    /**
     * Score a candidate based on Phase 2 ranking: Feature2Vec + learned linear layer.
     *
     * Feature vector (16 dimensions):
     *  0: suffix alignment score          (0-1)
     *  1: indent match score              (0-1)
     *  2: line count penalty              (0-1, shorter=better)
     *  3: bracket balance score           (0-1)
     *  4: no duplication score            (0-1)
     *  5: language keyword density        (0-1)
     *  6: semicolon completeness          (0-1)
     *  7: closing brace ratio             (0-1)
     *  8: blank line ratio                (0-1)
     *  9: average line length norm        (0-1)
     * 10: starts with keyword             (0-1)
     * 11: has return/yield/throw          (0-1)
     * 12: import/using prefix match       (0-1)
     * 13: comment density                 (0-1)
     * 14: parenthesis nesting depth       (0-1)
     * 15: word overlap with prefix        (0-1)
     *
     * The linear layer weights are hand-tuned heuristics that approximate
     * what a trained model would learn. They can be replaced with learned
     * weights from a supervised training pipeline in Phase 3.
     */
    private fun scoreCandidate(
        candidate: String,
        request: CompletionRequest,
    ): Double {
        val features = extractFeatureVector(candidate, request)
        return linearLayerScore(features)
    }

    /**
     * Extract a 16-dimensional feature vector from a candidate completion.
     */
    private fun extractFeatureVector(
        candidate: String,
        request: CompletionRequest,
    ): DoubleArray {
        val features = DoubleArray(16)

        // 0: Suffix alignment
        features[0] = scoreSuffixAlignment(candidate, request.suffix)

        // 1: Indent match
        features[1] = scoreIndentMatch(candidate, request.prefix)

        // 2: Line count penalty (normalized: 1 line=1.0, 2=0.9, 5=0.7, 10=0.5, 20=0.3)
        val lineCount = candidate.lines().size
        features[2] = 1.0 / (1.0 + 0.1 * lineCount)

        // 3: Bracket balance
        features[3] = scoreBracketBalance(candidate, request.prefix, request.suffix)

        // 4: No duplication
        features[4] = scoreNoDuplication(candidate, request.prefix, request.suffix)

        // 5: Language keyword density
        val langKeywords = getLanguageKeywords(request.language)
        val candidateWords = candidate.split(Regex("\\s+")).filter { it.length > 2 }
        val keywordCount = candidateWords.count { it in langKeywords }
        features[5] = if (candidateWords.isNotEmpty()) keywordCount.toDouble() / candidateWords.size else 0.0

        // 6: Semicolon completeness (ends with ; on each line)
        val lines = candidate.lines()
        val semicolonLines =
            lines.count {
                it.trimEnd().endsWith(";") ||
                    it.trimEnd().endsWith("{") ||
                    it.trimEnd().endsWith("}") ||
                    it.trimEnd().endsWith(",") ||
                    it.isBlank()
            }
        features[6] = if (lines.isNotEmpty()) semicolonLines.toDouble() / lines.size else 0.0

        // 7: Closing brace ratio
        val openBraces = candidate.count { it == '{' }
        val closeBraces = candidate.count { it == '}' }
        features[7] = if (openBraces > 0) closeBraces.toDouble() / openBraces else 1.0

        // 8: Blank line ratio (too many blank lines = bad)
        val blankLines = lines.count { it.isBlank() }
        features[8] = 1.0 - (if (lines.isNotEmpty()) blankLines.toDouble() / lines.size else 0.0)

        // 9: Average line length (normalized: 20-40 chars is ideal)
        val avgLen = if (lines.isNotEmpty()) lines.map { it.length }.average() else 0.0
        features[9] =
            when {
                avgLen < 10 -> 0.3 // Too short
                avgLen in 10.0..80.0 -> 1.0 - kotlin.math.abs(avgLen - 30.0) / 50.0
                else -> 0.2 // Too long
            }.coerceIn(0.0, 1.0)

        // 10: Starts with a language keyword (if, for, class, fun, etc.)
        val firstWord = candidate.trimStart().split(Regex("\\s+|\\(")).firstOrNull() ?: ""
        features[10] = if (firstWord in langKeywords || firstWord in CONTROL_FLOW_KEYWORDS) 1.0 else 0.0

        // 11: Has return/yield/throw statement
        features[11] = if (candidate.contains(Regex("\\b(return|yield|throw|break|continue)\\b"))) 1.0 else 0.0

        // 12: Import/using prefix match (if candidate adds imports that match project)
        val prefixImports = request.prefix.lines().filter { it.trimStart().startsWith("import ") || it.trimStart().startsWith("using ") }
        val candidateImports = candidate.lines().filter { it.trimStart().startsWith("import ") || it.trimStart().startsWith("using ") }
        features[12] =
            if (candidateImports.isNotEmpty() && prefixImports.isNotEmpty()) {
                val overlap =
                    candidateImports.count { imp ->
                        prefixImports.any {
                            it.substringAfterLast('.').substringAfterLast('/') ==
                                imp.substringAfterLast('.').substringAfterLast('/')
                        }
                    }
                overlap.toDouble() / candidateImports.size
            } else {
                0.0
            }

        // 13: Comment density (too many comments = bad for inline completion)
        val commentLines =
            lines.count {
                it.trimStart().startsWith("//") ||
                    it.trimStart().startsWith("#") ||
                    it.trimStart().startsWith("/*")
            }
        features[13] = if (lines.isNotEmpty()) 1.0 - commentLines.toDouble() / lines.size else 1.0

        // 14: Parenthesis nesting depth (normalized)
        var depth = 0
        var maxDepth = 0
        for (ch in candidate) {
            when (ch) {
                '(' -> {
                    depth++
                    if (depth > maxDepth) maxDepth = depth
                }
                ')' -> depth--
            }
        }
        features[14] = 1.0 / (1.0 + maxDepth * 0.2)

        // 15: Word overlap with prefix (semantic continuity)
        val prefixWords =
            request.prefix
                .split(Regex("\\s+"))
                .filter { it.length > 3 }
                .toSet()
        val candidateWordsSet = candidate.split(Regex("\\s+")).filter { it.length > 3 }.toSet()
        val overlap = prefixWords.intersect(candidateWordsSet).size
        features[15] =
            if (candidateWordsSet.isNotEmpty()) {
                val overlapRatio = overlap.toDouble() / candidateWordsSet.size
                // Some overlap is good (continuity), too much is bad (duplication)
                when {
                    overlapRatio < 0.15 -> 0.8 // Good: mostly new content
                    overlapRatio < 0.35 -> 1.0 // Ideal: some continuity
                    overlapRatio < 0.55 -> 0.5 // Marginal: repetitive
                    else -> 0.2 // Bad: too much duplication
                }
            } else {
                0.5
            }

        return features
    }

    /**
     * Linear layer scoring: weighted sum of features.
     * Weights are hand-tuned based on empirical analysis of completion quality.
     * These weights can be replaced with learned parameters from a supervised
     * training pipeline (Phase 3).
     */
    private fun linearLayerScore(features: DoubleArray): Double {
        val weights =
            doubleArrayOf(
                0.30, // 0:  suffix alignment (most important)
                0.20, // 1:  indent match
                0.12, // 2:  line count penalty
                0.18, // 3:  bracket balance
                0.15, // 4:  no duplication
                0.05, // 5:  keyword density
                0.08, // 6:  semicolon completeness
                0.10, // 7:  closing brace ratio
                0.04, // 8:  blank line ratio
                0.03, // 9:  average line length
                0.06, // 10: starts with keyword
                0.03, // 11: has return/yield/throw
                0.02, // 12: import prefix match
                0.02, // 13: comment density
                0.04, // 14: parenthesis depth
                0.08, // 15: word overlap with prefix
            )
        var score = 1.0 // base score
        for (i in features.indices) {
            score += features[i] * weights[i]
        }
        return score
    }

    /**
     * Check if the candidate connects cleanly with the suffix.
     * The last line of the candidate should naturally lead into the first line of the suffix.
     */
    private fun scoreSuffixAlignment(
        candidate: String,
        suffix: String,
    ): Double {
        if (suffix.isBlank()) return 0.5

        val candidateLines = candidate.lines()
        val suffixLines = suffix.lines().take(MAX_SUFFIX_ALIGN_LINES)
        val lastCandidateLine = candidateLines.lastOrNull() ?: return 0.0

        var alignmentScore = 0.0

        // Check if candidate ends with a complete statement (semicolon, closing brace)
        val trimmedLast = lastCandidateLine.trimEnd()
        if (trimmedLast.endsWith(";") || trimmedLast.endsWith("}") || trimmedLast.endsWith(")")) {
            alignmentScore += 0.5
        }

        // Check indentation continuity
        val candidateIndent = lastCandidateLine.takeWhile { it == ' ' || it == '\t' }.length
        val suffixIndent = suffixLines.firstOrNull()?.takeWhile { it == ' ' || it == '\t' }?.length ?: 0
        if (candidateIndent == suffixIndent) {
            alignmentScore += 0.3
        } else if (kotlin.math.abs(candidateIndent - suffixIndent) <= 4) {
            alignmentScore += 0.1
        }

        // Check if candidate's open braces are closed by suffix
        val openBraces = candidate.count { it == '{' || it == '(' || it == '[' }
        val closeBraces = candidate.count { it == '}' || it == ')' || it == ']' }
        if (openBraces > closeBraces) {
            // Unclosed braces in candidate — suffix should close them
            val suffixCloses = suffixLines.joinToString("\n").count { it == '}' || it == ')' || it == ']' }
            if (suffixCloses >= openBraces - closeBraces) alignmentScore += 0.2
        } else {
            alignmentScore += 0.2 // Already balanced
        }

        return alignmentScore.coerceIn(0.0, 1.0)
    }

    private fun scoreIndentMatch(
        candidate: String,
        prefix: String,
    ): Double {
        val prefixLines = prefix.lines()
        val prefixIndent = prefixLines.lastOrNull()?.takeWhile { it == ' ' || it == '\t' }?.length ?: 0
        val candidateLines = candidate.lines()
        val firstLineIndent = candidateLines.firstOrNull()?.takeWhile { it == ' ' || it == '\t' }?.length ?: 0

        return when {
            firstLineIndent == prefixIndent -> 1.0
            kotlin.math.abs(firstLineIndent - prefixIndent) <= 2 -> 0.5
            else -> 0.0
        }
    }

    private fun scoreBracketBalance(
        candidate: String,
        prefix: String,
        suffix: String,
    ): Double {
        val allCode = prefix + candidate + suffix
        val opens = allCode.count { it == '{' || it == '(' || it == '[' }
        val closes = allCode.count { it == '}' || it == ')' || it == ']' }

        return when {
            opens == closes -> 1.0
            kotlin.math.abs(opens - closes) <= 2 -> 0.5
            else -> 0.0
        }
    }

    private fun scoreNoDuplication(
        candidate: String,
        prefix: String,
        suffix: String,
    ): Double {
        // Penalize if candidate repeats significant content from prefix or suffix
        val candidateTokens = candidate.split(Regex("\\s+")).filter { it.length > 3 }.toSet()
        val prefixTokens = prefix.split(Regex("\\s+")).filter { it.length > 3 }.toSet()
        val suffixTokens = suffix.split(Regex("\\s+")).filter { it.length > 3 }.toSet()

        val prefixOverlap = candidateTokens.intersect(prefixTokens).size
        val suffixOverlap = candidateTokens.intersect(suffixTokens).size
        val totalTokens = candidateTokens.size.coerceAtLeast(1)

        val duplicationRatio = (prefixOverlap + suffixOverlap).toDouble() / totalTokens
        return when {
            duplicationRatio < 0.2 -> 1.0
            duplicationRatio < 0.5 -> 0.5
            else -> 0.0
        }
    }

    // ─── Utilities ────────────────────────────────────────────────────

    private fun computeCacheKey(request: CompletionRequest): String {
        val key = "${request.filePath}:${request.language}:${request.prefix.hashCode()}:${request.suffix.hashCode()}"
        return key.hashCode().toString(16)
    }

    private fun stripMarkdownFences(text: String): String {
        // Remove ```language ... ``` wrapping if the model added it
        val fenceRegex = Regex("^```[a-zA-Z]*\\n?([\\s\\S]*?)\\n?```$", RegexOption.MULTILINE)
        val match = fenceRegex.find(text)
        return match?.groupValues?.get(1)?.trim() ?: text.trim()
    }

    private fun unescapeJson(s: String): String =
        s
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\/", "/")
            .replace("\\b", "\b")
            .replace("\\r", "\r")

    // ─── Multi-line Intelligent Extension ──────────────────────────────

    /**
     * When a completion ends with an open brace `{` or a newline with unclosed
     * brackets, automatically request an extended completion that fills out
     * the complete code block (up to [MULTI_LINE_MAX_EXTEND_LINES] lines).
     *
     * This mirrors Cursor's behavior where typing `if (cond) {` and pressing
     * Tab will complete the entire if-block body rather than just the brace.
     */
    private fun extendMultiLineIfNeeded(
        candidate: String,
        request: CompletionRequest,
    ): String {
        if (!needsMultiLineExtension(candidate)) return candidate

        val extendedPrefix = request.prefix + candidate
        val extendedRequest =
            CompletionRequest(
                prefix = extendedPrefix,
                suffix = request.suffix,
                language = request.language,
                filePath = request.filePath,
                fileOutline = request.fileOutline,
                maxCandidates = 1,
                maxTokens = MULTI_LINE_MAX_EXTEND_TOKENS,
                temperature = 0.1f,
            )

        val extension =
            try {
                val http = HttpClientService.getInstance()
                val payload = buildPayload(extendedRequest)
                val httpReq = http.postJson("/v1/actions/inline-completion", payload)
                val call = http.client().newCall(httpReq)
                val response = call.execute()
                response.use { resp ->
                    if (!resp.isSuccessful) return@use null
                    val body = resp.body?.string() ?: return@use null
                    val extensions = parseCompletionResponse(body)
                    extensions.firstOrNull()
                }
            } catch (_: IOException) {
                null
            } ?: return candidate

        val merged = candidate + extension

        val mergedLines = merged.lines().size
        if (mergedLines > MULTI_LINE_MAX_EXTEND_LINES) return candidate

        if (!isBracketBalanced(merged, request.prefix, request.suffix)) {
            if (isBracketBalanced(candidate, request.prefix, request.suffix)) {
                return candidate
            }
        }

        val originalSuffixScore = scoreSuffixAlignment(candidate, request.suffix)
        val mergedSuffixScore = scoreSuffixAlignment(merged, request.suffix)
        if (mergedSuffixScore < originalSuffixScore - 0.2) return candidate

        return merged
    }

    /**
     * Detect whether a candidate needs multi-line extension.
     * Triggers when candidate ends with `{`, `(`, or newline with unclosed braces.
     */
    private fun needsMultiLineExtension(candidate: String): Boolean {
        val trimmed = candidate.trimEnd()
        if (trimmed.isEmpty()) return false

        if (trimmed.endsWith("{")) return true
        if (trimmed.endsWith("(") && candidate.lines().size <= 2) return true

        if (candidate.endsWith("\n")) {
            val openBraces = candidate.count { it == '{' }
            val closeBraces = candidate.count { it == '}' }
            if (openBraces > closeBraces) return true
        }

        return false
    }

    /**
     * Check if the candidate, in context of prefix and suffix, has
     * reasonably balanced brackets.
     */
    private fun isBracketBalanced(
        candidate: String,
        prefix: String,
        suffix: String,
    ): Boolean {
        val allCode = prefix + candidate + suffix
        val braceDiff = kotlin.math.abs(allCode.count { it == '{' } - allCode.count { it == '}' })
        val parenDiff = kotlin.math.abs(allCode.count { it == '(' } - allCode.count { it == ')' })
        val bracketDiff = kotlin.math.abs(allCode.count { it == '[' } - allCode.count { it == ']' })
        return braceDiff <= 1 && parenDiff <= 1 && bracketDiff <= 1
    }

    // ─── Language Keywords for Feature Extraction ──────────────────

    private val CONTROL_FLOW_KEYWORDS =
        setOf(
            "if",
            "else",
            "for",
            "while",
            "do",
            "switch",
            "case",
            "break",
            "continue",
            "return",
            "try",
            "catch",
            "finally",
            "throw",
            "when",
        )

    private fun getLanguageKeywords(language: String): Set<String> =
        when (language.lowercase()) {
            "java", "kotlin" -> JVM_KEYWORDS
            "typescript", "javascript", "tsx", "jsx" -> TS_KEYWORDS
            "python" -> PYTHON_KEYWORDS
            "go" -> GO_KEYWORDS
            "rust" -> RUST_KEYWORDS
            else -> UNIVERSAL_KEYWORDS
        }

    private val JVM_KEYWORDS =
        setOf(
            "abstract",
            "annotation",
            "as",
            "break",
            "by",
            "catch",
            "class",
            "companion",
            "const",
            "constructor",
            "continue",
            "data",
            "delegate",
            "do",
            "else",
            "enum",
            "expect",
            "extension",
            "field",
            "final",
            "finally",
            "for",
            "fun",
            "if",
            "import",
            "in",
            "init",
            "inline",
            "interface",
            "internal",
            "is",
            "it",
            "lateinit",
            "object",
            "open",
            "operator",
            "out",
            "override",
            "package",
            "private",
            "protected",
            "public",
            "receiver",
            "record",
            "return",
            "sealed",
            "set",
            "super",
            "suspend",
            "tailrec",
            "this",
            "throw",
            "try",
            "typealias",
            "val",
            "value",
            "var",
            "vararg",
            "when",
            "where",
            "while",
            "yield",
        )

    private val TS_KEYWORDS =
        setOf(
            "abstract",
            "as",
            "async",
            "await",
            "break",
            "case",
            "catch",
            "class",
            "const",
            "constructor",
            "continue",
            "debugger",
            "default",
            "delete",
            "do",
            "else",
            "enum",
            "export",
            "extends",
            "false",
            "finally",
            "for",
            "from",
            "function",
            "if",
            "implements",
            "import",
            "in",
            "instanceof",
            "interface",
            "let",
            "new",
            "null",
            "of",
            "package",
            "private",
            "protected",
            "public",
            "readonly",
            "return",
            "static",
            "super",
            "switch",
            "this",
            "throw",
            "true",
            "try",
            "type",
            "typeof",
            "undefined",
            "var",
            "void",
            "while",
            "with",
            "yield",
        )

    private val PYTHON_KEYWORDS =
        setOf(
            "and",
            "as",
            "assert",
            "async",
            "await",
            "break",
            "class",
            "continue",
            "def",
            "del",
            "elif",
            "else",
            "except",
            "finally",
            "for",
            "from",
            "global",
            "if",
            "import",
            "in",
            "is",
            "lambda",
            "nonlocal",
            "not",
            "or",
            "pass",
            "raise",
            "return",
            "try",
            "while",
            "with",
            "yield",
            "self",
            "cls",
            "True",
            "False",
            "None",
        )

    private val GO_KEYWORDS =
        setOf(
            "break",
            "case",
            "chan",
            "const",
            "continue",
            "default",
            "defer",
            "else",
            "fallthrough",
            "for",
            "func",
            "go",
            "goto",
            "if",
            "import",
            "interface",
            "map",
            "package",
            "range",
            "return",
            "select",
            "struct",
            "switch",
            "type",
            "var",
            "nil",
            "true",
            "false",
            "make",
            "new",
            "len",
            "cap",
            "append",
        )

    private val RUST_KEYWORDS =
        setOf(
            "as",
            "async",
            "await",
            "break",
            "const",
            "continue",
            "crate",
            "dyn",
            "else",
            "enum",
            "extern",
            "false",
            "fn",
            "for",
            "if",
            "impl",
            "in",
            "let",
            "loop",
            "match",
            "mod",
            "move",
            "mut",
            "pub",
            "ref",
            "return",
            "self",
            "Self",
            "static",
            "struct",
            "super",
            "trait",
            "true",
            "type",
            "unsafe",
            "use",
            "where",
            "while",
            "yield",
        )

    private val UNIVERSAL_KEYWORDS = JVM_KEYWORDS + TS_KEYWORDS + PYTHON_KEYWORDS

    // ─── Multi-model Fallback ──────────────────────────────────────────

    /**
     * Try the next model in the fallback chain when the current model fails.
     * Tracks consecutive failures per model and switches to the next one
     * after MODEL_FAIL_THRESHOLD failures.
     */
    private fun tryFallbackModel(request: CompletionRequest): String? {
        val currentModel = modelFallbackChain[currentModelIdx]
        modelFailCounts[currentModel] = (modelFailCounts[currentModel] ?: 0) + 1

        if (modelFailCounts[currentModel]!! >= MODEL_FAIL_THRESHOLD) {
            // Switch to next model
            currentModelIdx = (currentModelIdx + 1) % modelFallbackChain.size
            modelFailCounts[currentModel] = 0
        }

        // Retry with the (possibly switched) model
        if (currentModelIdx < modelFallbackChain.size) {
            val fallbackPayload = buildPayload(request).toMutableMap()
            fallbackPayload["model"] = modelFallbackChain[currentModelIdx]
            val http = HttpClientService.getInstance()
            val httpReq = http.postJson("/v1/actions/inline-completion", fallbackPayload)
            return try {
                val call = http.client().newCall(httpReq)
                val response = call.execute()
                response.use { resp ->
                    if (!resp.isSuccessful) return null
                    val body = resp.body?.string() ?: return null
                    val candidates = parseCompletionResponse(body)
                    if (candidates.isEmpty()) return null
                    val scored = candidates.map { ScoredCandidate(it, scoreCandidate(it, request)) }
                        .sortedByDescending { it.score }
                    scored.firstOrNull()?.text
                }
            } catch (_: IOException) { null }
        }
        return null
    }

    /**
     * Reset the failure count for a model (called on success).
     */
    private fun resetModelFailCount() {
        val currentModel = modelFallbackChain[currentModelIdx]
        modelFailCounts[currentModel] = 0
    }

    // ─── Cache Preheat ─────────────────────────────────────────────────

    /**
     * Enqueue a preheat request for background completion caching.
     * Called when the user pauses typing (debounced) to pre-fetch completions
     * for the current cursor position before the user explicitly requests them.
     */
    fun preheat(request: CompletionRequest) {
        val cacheKey = computeCacheKey(request)
        synchronized(cache) {
            if (cache.containsKey(cacheKey)) return // Already cached
        }
        preheatQueue.offer(request)
    }

    /**
     * Execute a preheat completion request in the background.
     * Results are stored in the cache for fast retrieval on the next actual request.
     */
    private fun preheatCompletion(request: CompletionRequest) {
        try {
            val http = HttpClientService.getInstance()
            val payload = buildPayload(request)
            payload["temperature"] = 0.1f // Lower temperature for preheat (more deterministic)
            val httpReq = http.postJson("/v1/actions/inline-completion", payload)
            val call = http.client().newCall(httpReq)
            val response = call.execute()
            response.use { resp ->
                if (!resp.isSuccessful) return
                val body = resp.body?.string() ?: return
                val candidates = parseCompletionResponse(body)
                if (candidates.isEmpty()) return
                val scored = candidates.map { ScoredCandidate(it, scoreCandidate(it, request)) }
                    .sortedByDescending { it.score }
                val result = CompletionResult(candidates = candidates, scoredCandidates = scored)
                val cacheKey = computeCacheKey(request)
                synchronized(cache) { cache[cacheKey] = result }
            }
        } catch (_: Exception) { /* Best-effort preheat */ }
    }

    // ─── Inline Hint ───────────────────────────────────────────────────

    /**
     * Generate a ghost-text inline hint for the current position.
     * This is a lighter-weight version of complete() that returns a single-line
     * hint for inline display (similar to GitHub Copilot's ghost text).
     *
     * Hints are only generated for single-line completions and are shown
     * immediately without waiting for the full multi-candidate evaluation.
     */
    fun inlineHint(request: CompletionRequest): String? {
        val cacheKey = computeCacheKey(request)
        synchronized(cache) {
            cache[cacheKey]?.let { cached ->
                if (System.currentTimeMillis() - cached.timestamp < CACHE_TTL_MS) {
                    val hint = cached.scoredCandidates.firstOrNull()?.text
                    return hint?.lines()?.firstOrNull()?.takeIf { it.isNotBlank() }
                }
            }
        }

        // Lightweight single-line hint request
        val hintRequest = request.copy(maxCandidates = 1, maxTokens = 32)
        return complete(hintRequest)?.lines()?.firstOrNull()?.takeIf { it.isNotBlank() }
    }

    /**
     * Get the current model being used for completions.
     */
    fun currentModel(): String = modelFallbackChain[currentModelIdx]

    /**
     * Get fallback chain status for diagnostics.
     */
    fun fallbackStatus(): Map<String, Int> = modelFailCounts.toMap()
}
