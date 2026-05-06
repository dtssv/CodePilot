package io.codepilot.plugin.completion

import io.codepilot.plugin.transport.HttpClientService
import java.io.IOException
import java.util.UUID

/**
 * Client for the backend inline-completion endpoint (`POST /v1/completion/inline`).
 * The endpoint returns SSE (same as ActionController); this client collects all `delta` events
 * and concatenates them into the final completion text.
 */
object InlineCompletionService {

    fun complete(request: CompletionRequest): String? {
        val http = HttpClientService.getInstance()
        val payload = mapOf(
            "sessionId" to UUID.randomUUID().toString(),
            "prefix" to request.prefix,
            "suffix" to request.suffix,
            "language" to request.language,
            "filePath" to request.filePath,
            "fileOutline" to request.fileOutline,
        )
        val httpReq = http.postJson("/v1/actions/inline-completion", payload)
        return try {
            val response = http.client().newCall(httpReq).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                extractTextFromSse(body)
            }
        } catch (_: IOException) {
            null
        }
    }

    /** Extracts concatenated text from SSE `delta` events: data:{"text":"..."} */
    private fun extractTextFromSse(sseBody: String): String? {
        val sb = StringBuilder()
        for (line in sseBody.lines()) {
            if (line.startsWith("data:")) {
                val data = line.removePrefix("data:").trim()
                val textMatch = Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(data)
                if (textMatch != null) {
                    val text = textMatch.groupValues[1]
                        .replace("\\n", "\n")
                        .replace("\\\"", "\"")
                        .replace("\\\\", "\\")
                    sb.append(text)
                }
            }
        }
        return sb.toString().trim().takeIf { it.isNotEmpty() }
    }

    data class CompletionRequest(
        val prefix: String,
        val suffix: String,
        val language: String,
        val filePath: String,
        val fileOutline: String? = null,
    )
}