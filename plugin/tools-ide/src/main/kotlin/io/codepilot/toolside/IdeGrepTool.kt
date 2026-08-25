package io.codepilot.toolside

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.harness.search.CodeSearcher
import io.codepilot.harness.search.GrepOpts
import io.codepilot.harness.search.Hit
import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import io.codepilot.harness.tool.WorkspaceScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * IDE-backed `grep` tool.
 *
 * Delegates the actual search to a [CodeSearcher] (wired by the host —
 * typically [io.codepilot.adapter.PsiSearcherAdapter] or a RipgrepSearcher),
 * then for each hit navigates the user's editor to the match location in the
 * IDE so the user can follow along as the agent searches.
 *
 * The pure algorithm lives in harness-core; this class only adds IDE
 * navigation. Results are returned to the agent as text exactly as the
 * delegate produced them.
 */
class IdeGrepTool(
    private val project: Project,
    private val searcher: CodeSearcher,
    @Suppress("unused") private val scope: WorkspaceScope,
) : Tool {

    override val spec = ToolSpec(
        name = "grep",
        description = "Search file contents. IDE-backed: hits are also navigated to in the editor.",
        parametersJson = """
            {"type":"object","properties":{
              "pattern":{"type":"string","description":"regex or literal"},
              "path_glob":{"type":"string","description":"optional glob filter"},
              "max_hits":{"type":"integer","default":100},
              "context_lines":{"type":"integer","default":0}
            },"required":["pattern"]}
        """.trimIndent(),
        dangerLevel = DangerLevel.SAFE,
    )

    override suspend fun execute(args: JsonObject): ToolOutput {
        val pattern = args["pattern"]?.jsonPrimitive?.content
            ?: return ToolOutput.failure("missing 'pattern'")
        val pathGlob = args["path_glob"]?.jsonPrimitive?.content
        val maxHits = args["max_hits"]?.jsonPrimitive?.intOrNull ?: 100
        val contextLines = args["context_lines"]?.jsonPrimitive?.intOrNull ?: 0

        val opts = GrepOpts(
            pathGlob = pathGlob,
            maxHits = maxHits,
            contextLines = contextLines,
        )
        val hits = searcher.grep(pattern, opts)
        navigateToFirstHit(hits)

        val sb = StringBuilder()
        if (hits.isEmpty()) {
            sb.append("(no matches)")
        } else {
            hits.forEach { h ->
                sb.append("${h.path}:${h.line}:${h.column}: ").append(h.lineContent).append('\n')
            }
        }
        return ToolOutput.success(sb.toString(), truncated = hits.size >= maxHits)
    }

    private fun navigateToFirstHit(hits: List<Hit>) {
        val first = hits.firstOrNull() ?: return
        val app = ApplicationManager.getApplication()
        app.invokeLater {
            val vFile = LocalFileSystem.getInstance().findFileByPath(first.path)
            if (vFile != null) {
                val mgr = FileEditorManager.getInstance(project)
                mgr.openFile(vFile, true)
                // Optionally move caret to first.line — requires Editor + caret
                // model plumbing; left as a TODO for polish.
            }
        }
    }
}
