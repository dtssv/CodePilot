package io.codepilot.harness.tool.exec

import io.codepilot.harness.model.AssistantToolCall
import io.codepilot.harness.tool.ToolCatalog
import io.codepilot.harness.tool.ToolOutput
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Executes tool calls with timeout, retry and JSON parsing.
 *
 * Design: the harness loop must not know how tools are invoked — it delegates here.
 * Concurrency is intentionally serial by default: LLM tool calls in a single turn
 * are executed in order and their results appended in order, so the event log
 * stays monotonic. A [parallel] mode is available for embarrassingly parallel calls
 * (e.g. multiple grep), but writes back to the session remain serial.
 */
class ToolExecutor(
    private val timeout: Duration = DEFAULT_TIMEOUT,
    private val maxRetries: Int = 0,
    private val parallel: Boolean = false,
) {
    /**
     * Execute a single [AssistantToolCall] against the [catalog].
     *
     * - Resolves the tool by name; unknown tools return failure.
     * - Parses argumentsJson into a JsonObject (empty object on blank).
     * - Wraps the call in [withTimeout].
     * - Retries up to [maxRetries] times on ToolOutput.failure (best effort).
     */
    suspend fun execute(call: AssistantToolCall, catalog: ToolCatalog): ToolOutput {
        val tool = catalog.get(call.name)
            ?: return ToolOutput.failure("unknown tool: ${call.name}")

        val args: JsonObject = try {
            val raw = call.argumentsJson.ifBlank { "{}" }
            val parsed = Json { ignoreUnknownKeys = true }.parseToJsonElement(raw)
            when (parsed) {
                is JsonObject -> parsed
                else -> return ToolOutput.failure("arguments must be a JSON object")
            }
        } catch (e: Exception) {
            return ToolOutput.failure("invalid arguments json: ${e.message}")
        }

        var lastErr: ToolOutput? = null
        repeat(maxRetries + 1) {
            try {
                val out = withTimeout(timeout) { tool.execute(args) }
                if (out.ok || maxRetries == 0) return out
                lastErr = out
            } catch (_: TimeoutCancellationException) {
                lastErr = ToolOutput.failure("tool ${call.name} timed out after $timeout")
            } catch (e: Exception) {
                lastErr = ToolOutput.failure("${e::class.simpleName}: ${e.message}")
            }
        }
        return lastErr ?: ToolOutput.failure("no result")
    }

    /**
     * Execute a batch of calls. Serial by default; parallel when [parallel] is true.
     * Returns results in the same order as the input calls.
     */
    suspend fun executeBatch(calls: List<AssistantToolCall>, catalog: ToolCatalog): List<ToolOutput> =
        if (parallel) {
            coroutineScope {
                calls.map { async { execute(it, catalog) } }.awaitAll()
            }
        } else {
            calls.map { execute(it, catalog) }
        }

    companion object {
        val DEFAULT_TIMEOUT: Duration = 30.seconds
    }
}
