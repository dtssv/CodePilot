package io.codepilot.plugin.conversation

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.Response

/** Parsed non-success HTTP response before the SSE body is consumed. */
data class SseHttpError(
    val httpStatus: Int,
    val apiCode: Int,
    val message: String,
    val retryAfterSec: Int,
    val opType: String?,
) {
    val isRateLimited: Boolean
        get() =
            httpStatus == 429
                || apiCode == SseHttpErrors.API_CODE_RATE_LIMITED
                || apiCode == SseHttpErrors.API_CODE_QUEUE_FULL
}

object SseHttpErrors {
    const val API_CODE_RATE_LIMITED = 42901
    const val API_CODE_QUEUE_FULL = 42902

    fun parse(
        response: Response,
        mapper: ObjectMapper,
    ): SseHttpError? {
        if (response.isSuccessful) return null
        val retryAfter = response.header("Retry-After")?.toIntOrNull()?.coerceIn(1, 600) ?: 60
        val opType = response.header("X-RateLimit-Type")
        val queueFull = "queue-full" == response.header("X-RateLimit-Reason")
        val body =
            try {
                response.peekBody(64 * 1024).string()
            } catch (_: Exception) {
                ""
            }
        var (apiCode, message) = parseApiEnvelope(body, mapper, response.code, response.message)
        if (queueFull || apiCode == API_CODE_QUEUE_FULL) {
            apiCode = API_CODE_QUEUE_FULL
            if (message.isBlank() || message.contains("频繁")) {
                message = "服务端 Agent 队列已满，请稍后重试"
            }
        }
        return SseHttpError(
            httpStatus = response.code,
            apiCode = apiCode,
            message = message,
            retryAfterSec = retryAfter,
            opType = opType,
        )
    }

    private fun parseApiEnvelope(
        body: String,
        mapper: ObjectMapper,
        httpCode: Int,
        httpMessage: String,
    ): Pair<Int, String> {
        if (body.isBlank()) {
            return defaultCode(httpCode) to defaultMessage(httpCode, httpMessage)
        }
        return try {
            val node: JsonNode = mapper.readTree(body)
            val code = node.path("code").asInt(defaultCode(httpCode))
            val msg = node.path("message").asText("").trim()
            code to msg.ifBlank { defaultMessage(httpCode, httpMessage) }
        } catch (_: Exception) {
            defaultCode(httpCode) to body.take(500)
        }
    }

    private fun defaultCode(httpCode: Int): Int =
        when (httpCode) {
            429 -> API_CODE_RATE_LIMITED
            else -> 50000 + httpCode
        }

    private fun defaultMessage(
        httpCode: Int,
        httpMessage: String,
    ): String =
        when (httpCode) {
            429 -> "请求过于频繁，请稍后再试"
            else -> httpMessage.ifBlank { "HTTP $httpCode" }
        }

    fun userMessage(
        err: SseHttpError,
        opLabel: String? = null,
    ): String {
        val op = opLabel ?: err.opType?.let(::opTypeLabel) ?: "接口"
        return "请求过于频繁（$op，${err.retryAfterSec} 秒后可重试）。${err.message}"
    }

    private fun opTypeLabel(opType: String): String =
        when (opType) {
            "agent" -> "Agent 对话"
            "chat" -> "对话"
            "completion" -> "补全"
            "tools" -> "工具"
            else -> opType
        }
}
