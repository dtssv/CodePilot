package io.codepilot.harness.tool.builtin

import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import io.codepilot.harness.tool.WorkspaceScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.io.path.writeText

/**
 * Enhanced `edit_file` tool backed by [PatchEngine]'s four-strategy escalation:
 * exact → lineTrim → fuzzy → subsequence.
 *
 * Replaces the 28-line MVP EditFileTool in FsTools.kt with a version robust to
 * the noise real LLM-generated search blocks carry (wrong indentation, skipped
 * lines, simplified blocks). The engine is sunk from PatchApplier.kt's private
 * matching methods — see [PatchEngine].
 *
 * Behaviour:
 *   - exact match (case-sensitive by default) — if unique, replace.
 *   - if multiple exact matches and replace_all=false → fail (ambiguous).
 *   - if zero exact matches → escalate through lineTrim / fuzzy / subsequence.
 *   - any successful strategy writes the file and reports the strategy used.
 */
class EditFileToolExt(private val scope: WorkspaceScope) : Tool {
    override val spec = ToolSpec(
        name = "edit_file",
        description = "Replace text in a workspace file. Escalates from exact → line-trim → fuzzy → subsequence matching to tolerate LLM-generated search block noise.",
        parametersJson = """{"type":"object","properties":{
            "path":{"type":"string"},
            "old_string":{"type":"string"},
            "new_string":{"type":"string"},
            "replace_all":{"type":"boolean","default":false},
            "regex":{"type":"boolean","default":false},
            "ignore_case":{"type":"boolean","default":false}
        },"required":["path","old_string","new_string"]}""",
        dangerLevel = DangerLevel.WRITE,
    )

    private val engine = PatchEngine()

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val path = scope.resolve(args["path"]!!.jsonPrimitive.content)
            ?: return ToolOutput.failure("path escapes workspace")
        if (!path.isRegularFile()) return ToolOutput.failure("not a file: ${path.fileName}")

        val oldS = args["old_string"]!!.jsonPrimitive.content
        val newS = args["new_string"]!!.jsonPrimitive.content
        val replaceAll = args["replace_all"]?.jsonPrimitive?.boolean ?: false
        val regex = args["regex"]?.jsonPrimitive?.boolean ?: false
        val ignoreCase = args["ignore_case"]?.jsonPrimitive?.boolean ?: false

        val original = path.readText()

        // First, try exact (with replaceAll semantics). If exact matches multiple
        // and replaceAll=false, fail with ambiguity (do not escalate — escalation
        // assumes zero matches, not ambiguous matches).
        val exact = engine.applyReplace(original, oldS, newS, regex, ignoreCase, replaceAll = true)
        if (exact.ok) {
            if (!replaceAll && exact.matches > 1) {
                return ToolOutput.failure("old_string matches ${exact.matches} times; pass replace_all=true")
            }
            path.writeText(exact.text)
            return ToolOutput.success("edited ${path.fileName} (exact, ${exact.matches} match(es))")
        }

        // Escalate. These strategies are inherently single-occurrence.
        if (regex) {
            return ToolOutput.failure("regex search did not match")
        }
        val result = engine.applyBestEffort(original, oldS, newS, regex = false, ignoreCase = ignoreCase, replaceAll = false)
        if (!result.ok) return ToolOutput.failure("old_string not found (tried exact/lineTrim/fuzzy/subsequence)")

        path.writeText(result.text)
        val strategy = describeStrategy(original, oldS, newS)
        ToolOutput.success("edited ${path.fileName} ($strategy)")
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }

    private fun describeStrategy(original: String, search: String, replace: String): String {
        // Determine which strategy succeeded by re-running in order.
        val exact = engine.applyReplace(original, search, replace, regex = false, ignoreCase = false, replaceAll = true)
        if (exact.ok) return "exact"
        if (engine.lineTrimReplace(original, search, replace).ok) return "lineTrim"
        if (engine.fuzzyReplace(original, search, replace).ok) return "fuzzy"
        if (engine.subsequenceReplace(original, search, replace).ok) return "subsequence"
        return "unknown"
    }
}
