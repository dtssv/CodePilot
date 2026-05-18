package io.codepilot.plugin.protocol

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.atomic.AtomicLong

/**
 * Project-scoped service that produces structured [EventEnvelope]s and forwards them
 * to the WebUI through a pluggable dispatcher (typically wired by CefChatPanel).
 *
 * Key responsibilities:
 *  - Allocate monotonic [seq] numbers (per Plugin process).
 *  - Buffer the last [MAX_BUFFER] envelopes for [replaySince] (gap recovery).
 *  - Provide convenience helpers ([emit], [startTurn], [endTurn], etc.) that the
 *    rest of the plugin (CefChatPanel adapter, ToolDispatcher, future hooks) can use
 *    instead of hand-rolling event payloads.
 */
@Service(Service.Level.PROJECT)
class EventBus(@Suppress("unused") private val project: Project) {
    private val log = logger<EventBus>()
    private val seq = AtomicLong(0)
    private val buffer = ConcurrentLinkedDeque<EventEnvelope>()

    /**
     * Dispatcher set by the WebUI host (CefChatPanel). When null, events are
     * still recorded into the replay buffer but not pushed to any UI — this
     * allows headless tests or non-WebUI hosts to observe the protocol.
     */
    @Volatile
    private var dispatcher: ((EventEnvelope) -> Unit)? = null

    fun setDispatcher(d: ((EventEnvelope) -> Unit)?) {
        dispatcher = d
    }

    fun nextSeq(): Long = seq.incrementAndGet()

    /** Emit a generic envelope and return it. */
    fun emit(
        turnId: String,
        stepId: String,
        type: String,
        payload: Any? = null,
        parentStepId: String? = null,
    ): EventEnvelope {
        val env =
            EventEnvelope(
                seq = nextSeq(),
                turnId = turnId,
                stepId = stepId,
                parentStepId = parentStepId,
                ts = System.currentTimeMillis(),
                type = type,
                payload = payload,
            )
        pushBuffer(env)
        try {
            dispatcher?.invoke(env)
        } catch (t: Throwable) {
            log.warn("EventBus dispatcher threw for type=$type", t)
        }
        return env
    }

    // ---------- Convenience helpers (covers the common shapes) ---------- //

    fun startTurn(
        turnId: String,
        userMessage: String,
        contextRefs: List<Map<String, Any?>> = emptyList(),
        images: List<Map<String, Any?>> = emptyList(),
        forkMessageIndex: Int? = null,
    ) =
        emit(
            turnId = turnId,
            stepId = turnId,
            type = EventTypes.TURN_START,
            payload =
                buildMap {
                    put("userMessage", userMessage)
                    put("contextRefs", contextRefs)
                    if (images.isNotEmpty()) put("images", images)
                    if (forkMessageIndex != null) put("forkMessageIndex", forkMessageIndex)
                },
        )

    fun endTurn(turnId: String, status: String, reason: String? = null) =
        emit(
            turnId = turnId,
            stepId = turnId,
            type = EventTypes.TURN_END,
            payload = mapOf("turnId" to turnId, "status" to status, "reason" to reason),
        )

    fun startStep(turnId: String, stepId: String, kind: String, title: String, parentStepId: String? = null) =
        emit(
            turnId = turnId,
            stepId = stepId,
            type = EventTypes.STEP_START,
            parentStepId = parentStepId,
            payload = mapOf(
                "stepId" to stepId,
                "kind" to kind,
                "title" to title,
                "parentStepId" to parentStepId,
            ),
        )

    fun endStep(turnId: String, stepId: String, status: String, error: String? = null) =
        emit(
            turnId = turnId,
            stepId = stepId,
            type = EventTypes.STEP_END,
            payload = mapOf("stepId" to stepId, "status" to status, "error" to error),
        )

    fun textDelta(turnId: String, stepId: String, text: String) =
        emit(
            turnId = turnId,
            stepId = stepId,
            type = EventTypes.TEXT_DELTA,
            payload = mapOf("stepId" to stepId, "text" to text),
        )

    fun toolCall(turnId: String, stepId: String, tool: String, args: Any?, parentStepId: String? = null) =
        emit(
            turnId = turnId,
            stepId = stepId,
            type = EventTypes.TOOL_CALL,
            parentStepId = parentStepId,
            payload = mapOf("stepId" to stepId, "tool" to tool, "args" to args),
        )

    fun toolProgress(turnId: String, stepId: String, partial: Any?) =
        emit(
            turnId = turnId,
            stepId = stepId,
            type = EventTypes.TOOL_PROGRESS,
            payload = mapOf("stepId" to stepId, "partial" to partial),
        )

    fun toolResult(turnId: String, stepId: String, ok: Boolean, result: Any? = null, error: String? = null) =
        emit(
            turnId = turnId,
            stepId = stepId,
            type = EventTypes.TOOL_RESULT,
            payload = mapOf("stepId" to stepId, "ok" to ok, "result" to result, "error" to error),
        )

    // ---------- Replay support ---------- //

    /** Return all buffered envelopes whose seq is strictly greater than [lastSeq]. */
    fun replaySince(lastSeq: Long): List<EventEnvelope> =
        buffer.asSequence().filter { it.seq > lastSeq }.sortedBy { it.seq }.toList()

    fun currentSeq(): Long = seq.get()

    private fun pushBuffer(env: EventEnvelope) {
        buffer.addLast(env)
        while (buffer.size > MAX_BUFFER) buffer.pollFirst()
    }

    companion object {
        const val MAX_BUFFER = 5000

        fun getInstance(project: Project): EventBus = project.service()
    }
}
