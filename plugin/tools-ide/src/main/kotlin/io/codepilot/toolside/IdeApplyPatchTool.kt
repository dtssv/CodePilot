package io.codepilot.toolside

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.WorkspaceScope
import io.codepilot.harness.tool.builtin.ApplyPatchTool
import kotlinx.serialization.json.JsonObject
import java.nio.file.Path

/**
 * IDE-backed `apply_patch` tool.
 *
 * Delegates unified-diff parsing/application to the pure-JVM [ApplyPatchTool],
 * then refreshes VFS and reloads open documents for every file the patch
 * touched — so the IDE shows the new content immediately.
 *
 * Diff-dialog-before-apply is a TODO for M3.
 */
class IdeApplyPatchTool(
    private val project: Project,
    scope: WorkspaceScope,
) : Tool {

    private val delegate = ApplyPatchTool(scope)

    override val spec = delegate.spec

    override suspend fun execute(args: JsonObject): ToolOutput {
        val result = delegate.execute(args)
        if (result.ok) {
            // The patch may have touched multiple files; refresh any path
            // mentioned in the output (delegate reports them in stdout).
            refreshTouchedFiles(result.stdout)
        }
        return result
    }

    private fun refreshTouchedFiles(stdout: String) {
        // The delegate prints "patched: <path>" lines per file; parse them.
        val paths = stdout.lineSequence()
            .mapNotNull { line ->
                val prefix = "patched:"
                if (line.startsWith(prefix)) {
                    line.removePrefix(prefix).trim().takeIf { it.isNotEmpty() }
                } else null
            }
            .toList()
        if (paths.isEmpty()) return
        val app = ApplicationManager.getApplication()
        app.invokeLater {
            WriteCommandAction.runWriteCommandAction(project) {
                paths.forEach { p ->
                    val vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(p)
                    if (vFile != null) {
                        vFile.refresh(false, false)
                        val doc = FileDocumentManager.getInstance().getDocument(vFile)
                        if (doc != null && doc.isWritable) {
                            FileDocumentManager.getInstance().reloadFromDisk(doc)
                        }
                    }
                }
            }
        }
    }

    @Suppress("unused") // kept for future PSI-based path resolution
    private fun toPath(s: String): Path = Path.of(s)
}
