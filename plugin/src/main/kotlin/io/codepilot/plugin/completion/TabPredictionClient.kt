package io.codepilot.plugin.completion

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import io.codepilot.plugin.transport.HttpClientService

/**
 * Optional model-backed tab predictions via `POST /v1/tab/predict`.
 * Falls back to empty when backend is unreachable or returns low-confidence edits.
 */
@Service(Service.Level.PROJECT)
class TabPredictionClient(private val project: Project) {
    private val log = Logger.getInstance(TabPredictionClient::class.java)
    private val mapper = ObjectMapper()

    data class PredictResult(
        val edits: List<PredictedEdit>,
        val source: String = "heuristics",
    )

    data class PredictedEdit(
        val path: String,
        val offset: Int,
        val newText: String,
        val confidence: Double,
        val source: String = "model",
    )

    fun predict(
        filePath: String,
        language: String,
        prefix: String,
        suffix: String,
        cursorLine: Int,
        cursorColumn: Int,
        cursorOffset: Int,
        currentLinePrefix: String = "",
        currentLineSuffix: String = "",
    ): PredictResult {
        if (!TabCompletionSupport.isEnabled()) return PredictResult(emptyList())
        return try {
            val http = HttpClientService.getInstance()
            val body =
                mapOf(
                    "filePath" to filePath,
                    "language" to language,
                    "prefix" to prefix,
                    "suffix" to suffix,
                    "cursorLine" to cursorLine,
                    "cursorColumn" to cursorColumn,
                    "currentLinePrefix" to currentLinePrefix,
                    "currentLineSuffix" to currentLineSuffix,
                )
            http.client().newCall(http.postJson("/v1/tab/predict", body)).execute().use { resp ->
                if (!resp.isSuccessful) return PredictResult(emptyList())
                val root = mapper.readTree(resp.body?.bytes() ?: return PredictResult(emptyList()))
                parseResult(root.path("data"), cursorOffset, cursorLine, prefix, suffix)
            }
        } catch (e: Exception) {
            log.warn("[TabPredict] ${e.message}")
            PredictResult(emptyList())
        }
    }

    fun predictAsync(
        filePath: String,
        language: String,
        prefix: String,
        suffix: String,
        cursorLine: Int,
        cursorColumn: Int,
        cursorOffset: Int,
        currentLinePrefix: String = "",
        currentLineSuffix: String = "",
        onResult: (PredictResult) -> Unit,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result =
                predict(
                    filePath,
                    language,
                    prefix,
                    suffix,
                    cursorLine,
                    cursorColumn,
                    cursorOffset,
                    currentLinePrefix,
                    currentLineSuffix,
                )
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) onResult(result)
            }
        }
    }

    private fun parseResult(
        data: JsonNode,
        cursorOffset: Int,
        cursorLine: Int,
        prefix: String,
        suffix: String,
    ): PredictResult {
        val apiSource = data.path("source").asText("model")
        val edits = data.path("edits")
        if (!edits.isArray) return PredictResult(emptyList(), apiSource)
        val out = mutableListOf<PredictedEdit>()
        for (node in edits) {
            val confidence = node.path("confidence").asDouble(0.0)
            if (confidence < MIN_CONFIDENCE) continue
            val newText = node.path("newText").asText("")
            val aligned = alignInsertWithContext(prefix, suffix, newText)
            if (!isAcceptableTabInsert(aligned)) continue
            val path = node.path("path").asText("")
            val range = node.path("range")
            val startLine = range.path("startLine").asInt(-1)
            val rangeOffset = if (range.has("offset")) range.path("offset").asInt(-1) else -1
            val offset =
                resolveInsertOffset(
                    cursorOffset = cursorOffset,
                    cursorLine = cursorLine,
                    startLine = startLine,
                    rangeOffset = rangeOffset,
                )
            out.add(
                PredictedEdit(
                    path = path,
                    offset = offset,
                    newText = aligned,
                    confidence = confidence,
                    source = apiSource,
                ),
            )
        }
        return PredictResult(out, apiSource)
    }

    /** Tab/FIM completions are always insert-at-caret unless API sends a positive absolute offset on another line. */
    private fun resolveInsertOffset(
        cursorOffset: Int,
        cursorLine: Int,
        startLine: Int,
        rangeOffset: Int,
    ): Int {
        if (rangeOffset > 0 && startLine >= 0 && startLine == cursorLine) {
            return rangeOffset
        }
        return cursorOffset
    }

    private fun isAcceptableTabInsert(newText: String): Boolean {
        if (newText.isBlank()) return false
        val lines = newText.lines()
        if (lines.size > MAX_GHOST_LINES) return false
        if (newText.length > MAX_GHOST_CHARS) return false
        if (newText.startsWith("# ") && lines.size > 2) return false
        if (newText.contains("\n## ") && lines.size > 2) return false
        if (newText.contains("```") || newText.contains("**")) return false
        if (newText.trimStart().startsWith("{") &&
            (newText.contains("\"predictions\"") || newText.contains("\"insertText\""))
        ) {
            return false
        }
        if (newText.contains("代码分析") || newText.startsWith("这是一个") || newText.contains("我来")) return false
        val lower = newText.lowercase()
        if (lower.startsWith("the output") || lower.contains("would be:")) return false
        val hanCount = newText.count { it.code in 0x4E00..0x9FFF }
        val hasCodeToken =
            newText.any { it in ";{}<>=:" } || "<<" in newText || ">>" in newText || "::" in newText
        if (hanCount >= 6 && !hasCodeToken) return false
        return true
    }

    /** Drop insertions that repeat PREFIX/SUFFIX or duplicate a prior statement on the line. */
    private fun alignInsertWithContext(
        prefix: String,
        suffix: String,
        insert: String,
    ): String {
        val t = insert.trim()
        if (t.isEmpty()) return ""
        if (prefix.endsWith(t) || suffix.startsWith(t)) return ""
        val lastLine = prefix.substringAfterLast('\n')
        if (t.length >= 4 && lastLine.contains(t)) return ""
        if (t.startsWith("<<") && prefix.contains("<<") && prefix.contains(t.removePrefix("<").trim())) {
            return ""
        }
        return t
    }

    companion object {
        private const val MIN_CONFIDENCE = 0.35
        private const val MAX_GHOST_CHARS = 120
        private const val MAX_GHOST_LINES = 3

        fun getInstance(project: Project): TabPredictionClient = project.service()
    }
}
