package io.codepilot.plugin.completion

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

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
    ): PredictResult {
        val baseUrl = CodePilotSettings.getInstance().state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return PredictResult(emptyList())
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
                )
            val payload = mapper.writeValueAsBytes(body)
            val req =
                Request
                    .Builder()
                    .url((baseUrl.trimEnd('/') + "/v1/tab/predict").toHttpUrl())
                    .post(payload.toRequestBody("application/json; charset=utf-8".toMediaType()))
                    .header("Accept", "application/json")
                    .build()
            http.client().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return PredictResult(emptyList())
                val root = mapper.readTree(resp.body?.bytes() ?: return PredictResult(emptyList()))
                parseResult(root.path("data"), filePath, cursorOffset)
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
        onResult: (PredictResult) -> Unit,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = predict(filePath, language, prefix, suffix, cursorLine, cursorColumn, cursorOffset)
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) onResult(result)
            }
        }
    }

    private fun parseResult(data: JsonNode, filePath: String, cursorOffset: Int): PredictResult {
        val apiSource = data.path("source").asText("model")
        val edits = data.path("edits")
        if (!edits.isArray) return PredictResult(emptyList(), apiSource)
        val out = mutableListOf<PredictedEdit>()
        for (node in edits) {
            val confidence = node.path("confidence").asDouble(0.0)
            if (confidence < MIN_CONFIDENCE) continue
            val newText = node.path("newText").asText("")
            if (newText.isBlank()) continue
            val path = node.path("path").asText(filePath)
            val range = node.path("range")
            val startLine = range.path("startLine").asInt(0)
            val offset =
                if (range.has("offset")) {
                    range.path("offset").asInt(cursorOffset)
                } else {
                    cursorOffset
                }
            out.add(
                PredictedEdit(
                    path = path,
                    offset = offset,
                    newText = newText,
                    confidence = confidence,
                    source = apiSource,
                ),
            )
            if (startLine > 0 && !range.has("offset")) {
                // keep offset at cursor when API only sends line numbers
            }
        }
        return PredictResult(out, apiSource)
    }

    companion object {
        private const val MIN_CONFIDENCE = 0.35

        fun getInstance(project: Project): TabPredictionClient = project.service()
    }
}
