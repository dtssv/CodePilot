package io.codepilot.plugin.completion

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import java.util.concurrent.atomic.AtomicLong

/**
 * P0-04 — Application-scope counters and EventBus emitter for Tab inline-completion
 * lifecycle (suggest / accept / dismiss). [CodePilotInlineCompletionProvider] and the
 * platform completion listener call into this; the WebUI tab settings panel reads
 * snapshots through [snapshot] (delivered by `tab.stats_response`).
 *
 * Counters are intentionally process-global (Application service): tab completion
 * is keyed by project but the user typically wants aggregate stats across projects.
 * Acceptance latency is averaged via a tiny ring buffer.
 */
@Service(Service.Level.APP)
class TabFeedback {
    private val suggestCount = AtomicLong(0)
    private val acceptCount = AtomicLong(0)
    private val dismissCount = AtomicLong(0)
    private val latencySum = AtomicLong(0)
    private val latencySamples = AtomicLong(0)

    /** Latency of the most recent suggestion (ms), tracked for the "average latency" stat. */
    fun recordSuggest(project: Project?, filePath: String, latencyMs: Long, length: Int) {
        suggestCount.incrementAndGet()
        if (latencyMs >= 0) {
            latencySum.addAndGet(latencyMs)
            latencySamples.incrementAndGet()
        }
        emit(project, EventTypes.TAB_SUGGEST, mapOf(
            "file" to filePath,
            "len" to length,
            "latencyMs" to latencyMs,
        ))
    }

    fun recordAccept(project: Project?, filePath: String, length: Int) {
        acceptCount.incrementAndGet()
        emit(project, EventTypes.TAB_ACCEPT, mapOf("file" to filePath, "len" to length))
    }

    fun recordDismiss(project: Project?, reason: String) {
        dismissCount.incrementAndGet()
        emit(project, EventTypes.TAB_DISMISS, mapOf("reason" to reason))
    }

    /** Snapshot, safe for serialization to the WebUI. */
    fun snapshot(): Map<String, Any?> {
        val s = suggestCount.get()
        val a = acceptCount.get()
        val d = dismissCount.get()
        val samples = latencySamples.get()
        val avgLatency = if (samples > 0) latencySum.get() / samples else 0L
        val acceptRate = if (s > 0) a.toDouble() / s.toDouble() else 0.0
        return mapOf(
            "suggestCount" to s,
            "acceptCount" to a,
            "dismissCount" to d,
            "avgLatencyMs" to avgLatency,
            "acceptRate" to acceptRate,
        )
    }

    fun reset() {
        suggestCount.set(0); acceptCount.set(0); dismissCount.set(0)
        latencySum.set(0); latencySamples.set(0)
    }

    private fun emit(project: Project?, type: String, payload: Map<String, Any?>) {
        if (project == null) return
        try {
            EventBus.getInstance(project).emit(
                turnId = "tab",
                stepId = "tab-${System.nanoTime()}",
                type = type,
                payload = payload,
            )
        } catch (_: Throwable) {
            // EventBus may not be initialized in unit tests; silently drop.
        }
    }

    companion object {
        fun getInstance(): TabFeedback = service()
    }
}
