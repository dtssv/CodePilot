package io.codepilot.plugin.conversation

import com.fasterxml.jackson.databind.JsonNode
import io.codepilot.plugin.transport.HttpClientService
import org.slf4j.LoggerFactory

/**
 * Client-side admission probe — checks server capacity before opening an agent SSE run.
 *
 * This is a **single-shot** probe: the caller decides retry timing and attempts.
 * No blocking Thread.sleep is used here — the Kotlin side manages retries asynchronously
 * so the IDE remains responsive.
 */
object ConversationRunAdmission {
    private val log = LoggerFactory.getLogger(ConversationRunAdmission::class.java)

    data class Status(
        val admit: Boolean,
        val retryAfterSec: Int,
        val userQueued: Long = 0,
        val userRunning: Long = 0,
        val globalQueued: Long = 0,
        val globalRunning: Long = 0,
        val maxUserQueued: Int = 8,
        val maxUserRunning: Int = 2,
    )

    /**
     * Single-shot admission probe — returns the current server capacity status.
     * No blocking, no retry loop. The caller is responsible for retry scheduling.
     */
    fun probe(http: HttpClientService = HttpClientService.getInstance()): Status? {
        val req = http.get("/v1/conversation/runs/admission")
        return try {
            http.client().newCall(req).execute().use { response ->
                if (!response.isSuccessful) {
                    log.warn("Admission probe HTTP {}", response.code)
                    return null
                }
                val body = response.body?.string() ?: return null
                val root: JsonNode = http.mapper.readTree(body)
                val data = root.path("data")
                val limits = data.path("limits")
                Status(
                    admit = data.path("admit").asBoolean(true),
                    retryAfterSec = data.path("retryAfterSec").asInt(30).coerceIn(2, 600),
                    userQueued = data.path("userQueued").asLong(0),
                    userRunning = data.path("userRunning").asLong(0),
                    globalQueued = data.path("globalQueued").asLong(0),
                    globalRunning = data.path("globalRunning").asLong(0),
                    maxUserQueued = limits.path("maxUserQueued").asInt(8).coerceAtLeast(1),
                    maxUserRunning = limits.path("maxUserRunning").asInt(2).coerceAtLeast(1),
                )
            }
        } catch (e: Exception) {
            log.warn("Admission probe failed: {}", e.message)
            null
        }
    }
}