package io.codepilot.toolside

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.WorkspaceScope
import io.codepilot.harness.tool.builtin.EditFileToolExt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * IDE-backed `edit_file` tool.
 *
 * Delegates the matching/patching algorithm to the pure-JVM [EditFileToolExt]
 * (which uses PatchEngine's four-strategy escalation), but wraps the
 * resulting disk write in:
 *   - [WriteCommandAction] so the change is undoable from the IDE
 *   - VFS refresh so the file editor picks up the new content immediately
 *
 * If the file is open in an editor, the document is reloaded from disk after
 * the write so the user sees the patched version without a manual reload.
 *
 * The diff-viewer integration (showing a diff before auto-applying) is left
 * as a TODO for M3 — for now we apply directly and rely on undo.
 */
class IdeEditFileTool(
    private val project: Project,
    scope: WorkspaceScope,
) : Tool {

    private val delegate = EditFileToolExt(scope)

    override val spec = delegate.spec

    override suspend fun execute(args: JsonObject): ToolOutput {
        val pathStr = args["path"]?.jsonPrimitive?.content
        val result = delegate.execute(args)
        if (result.ok && pathStr != null) {
            refreshAndReload(pathStr)
        }
        return result
    }

    private fun refreshAndReload(pathStr: String) {
        val app = ApplicationManager.getApplication()
        app.invokeLater {
            WriteCommandAction.runWriteCommandAction(project) {
                val vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(pathStr)
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
