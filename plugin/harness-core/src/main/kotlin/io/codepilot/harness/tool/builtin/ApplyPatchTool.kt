package io.codepilot.harness.tool.builtin

import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import io.codepilot.harness.tool.WorkspaceScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.io.path.writeText

/**
 * `apply_patch` tool: apply a unified-diff patch to workspace files.
 *
 * Sunk from PatchApplier.applyUnifiedHunks / applySelectedHunks. The IDE
 * version wraps each write in WriteCommandAction and shows a diff dialog;
 * this pure version just writes the patched bytes to disk. The IDE adapter
 * layer can post-process the returned ToolOutput to render diffs.
 *
 * Patch format (git-style):
 * ```
 * --- a/path/to/file
 * +++ b/path/to/file
 * @@ -10,3 +10,3 @@
 *  unchanged line
 * -old line
 * +new line
 *  another unchanged
 * ```
 *
 * Multiple files supported: each `+++ b/` header starts a new file.
 */
class ApplyPatchTool(private val scope: WorkspaceScope) : Tool {
    override val spec = ToolSpec(
        name = "apply_patch",
        description = "Apply a unified-diff patch to workspace files. Supports multiple files and @@ hunks.",
        parametersJson = """{"type":"object","properties":{
            "patch":{"type":"string","description":"Full unified diff text (---/+++/@@ headers)"}
        },"required":["patch"]}""",
        dangerLevel = DangerLevel.WRITE,
    )

    private val engine = PatchEngine()

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val patchText = args["patch"]!!.jsonPrimitive.content
        if (patchText.isBlank()) return ToolOutput.failure("empty patch")

        val applied = mutableListOf<String>()
        for ((relPath, hunks) in splitByFile(patchText)) {
            val path = scope.resolve(relPath)
                ?: return ToolOutput.failure("path escapes workspace: $relPath")
            val original = if (path.toFile().exists()) path.toFile().readText() else ""
            val patched = engine.applyUnifiedHunks(original, hunks.joinToString("\n"))
            if (patched != original) {
                path.parent?.toFile()?.mkdirs()
                path.writeText(patched)
                applied += relPath
            }
        }
        if (applied.isEmpty()) ToolOutput.success("no changes applied")
        else ToolOutput.success("patched ${applied.size} file(s): ${applied.joinToString(", ")}")
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }

    /**
     * Split a git-style unified diff into per-file (path, hunkLines) pairs.
     */
    private fun splitByFile(patchText: String): List<Pair<String, List<String>>> {
        val out = mutableListOf<Pair<String, MutableList<String>>>()
        var current: Pair<String, MutableList<String>>? = null
        for (line in patchText.lines()) {
            when {
                line.startsWith("+++ b/") -> {
                    if (current != null && current!!.second.isNotEmpty()) out.add(current!!)
                    val path = line.removePrefix("+++ b/").trim()
                    current = path to mutableListOf()
                }
                line.startsWith("+++ ") -> {
                    if (current != null && current!!.second.isNotEmpty()) out.add(current!!)
                    val path = line.removePrefix("+++ ").trim()
                    current = path to mutableListOf()
                }
                line.startsWith("--- ") -> { /* skip --- lines */ }
                current != null -> current!!.second.add(line)
            }
        }
        if (current != null && current!!.second.isNotEmpty()) out.add(current!!)
        return out
    }
}
