package io.codepilot.harness.testfix

import io.codepilot.harness.model.AssistantToolCall
import io.codepilot.harness.model.ScriptedTurn
import io.codepilot.harness.model.StopKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path

/**
 * Loads a scripted scenario from a NDJSON file (one JSON object per line) and
 * replays it through a [FakeChatModel].
 *
 * Scenario file format (one turn per line):
 * ```
 * {"text":"Let me read the file","tool_calls":[{"id":"c1","name":"read_file","arguments_json":"{\"path\":\"App.kt\"}"}],"stop":"tool_use"}
 * {"text":"Done."}
 * ```
 *
 * Unspecified fields default: text=null, tool_calls=[], stop=end_turn when no
 * tool calls else tool_use, usage=(100,50), fail=null.
 *
 * This is the regression-test substrate: a recorded prod/hand-test traffic can
 * be dumped as a scenario file and replayed against any harness change.
 */
object ScenarioLoader {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
    }

    fun load(path: Path): List<ScriptedTurn> {
        if (!Files.exists(path)) return emptyList()
        return Files.readAllLines(path).asSequence()
            .filter { it.isNotBlank() && !it.trimStart().startsWith("#") }
            .map { line -> json.decodeFromString(ScenarioTurnSerde.serializer(), line) }
            .map { it.toDomain() }
            .toList()
    }

    fun dump(turns: List<ScriptedTurn>, path: Path) {
        val sb = StringBuilder()
        for (t in turns) {
            val s = ScenarioTurnSerde.fromDomain(t)
            sb.append(json.encodeToString(ScenarioTurnSerde.serializer(), s)).append('\n')
        }
        Files.createDirectories(path.parent)
        Files.writeString(path, sb.toString())
    }
}

@Serializable
private data class ScenarioTurnSerde(
    val text: String? = null,
    val tool_calls: List<ToolCallSerde> = emptyList(),
    val stop: String = "",
    val in_tok: Long = 100,
    val out_tok: Long = 50,
    val fail: String? = null,
) {
    fun toDomain(): ScriptedTurn {
        val calls = tool_calls.map {
            AssistantToolCall(callId = it.id, name = it.name, argumentsJson = it.arguments_json)
        }
        val stopKind = when (stop) {
            "end_turn", "" -> if (calls.isEmpty()) StopKind.END_TURN else StopKind.TOOL_USE
            "tool_use" -> StopKind.TOOL_USE
            "max_tokens" -> StopKind.MAX_TOKENS
            "error" -> StopKind.ERROR
            else -> if (calls.isEmpty()) StopKind.END_TURN else StopKind.TOOL_USE
        }
        return ScriptedTurn(
            text = text,
            toolCalls = calls,
            stop = stopKind,
            usage = in_tok to out_tok,
            fail = fail,
        )
    }

    companion object {
        fun fromDomain(t: ScriptedTurn): ScenarioTurnSerde = ScenarioTurnSerde(
            text = t.text,
            tool_calls = t.toolCalls.map { ToolCallSerde(it.callId, it.name, it.argumentsJson) },
            stop = when (t.stop) {
                StopKind.END_TURN -> "end_turn"
                StopKind.TOOL_USE -> "tool_use"
                StopKind.MAX_TOKENS -> "max_tokens"
                StopKind.ERROR -> "error"
            },
            in_tok = t.usage.first,
            out_tok = t.usage.second,
            fail = t.fail,
        )
    }
}

@Serializable
private data class ToolCallSerde(
    val id: String,
    val name: String,
    val arguments_json: String,
)
