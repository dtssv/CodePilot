package io.codepilot.plugin.actions

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

/**
 * Apply Code Action — handles "Apply" button clicks from Chat code blocks.
 *
 * When the user clicks "Apply" on a code block in the Chat UI, the webui
 * sends a `apply_code_block` bridge event with { code, language, filePath }.
 * This action locates the target file, applies the code change, and
 * shows a diff preview via the standard IntelliJ diff viewer.
 */
object ApplyCodeAction {
    private val log = logger<ApplyCodeAction>()

    @JvmStatic
    fun applyCodeBlock(project: Project, code: String, language: String, filePath: String?) {
        if (filePath.isNullOrBlank()) {
            log.warn("Apply code block: no filePath specified, cannot apply")
            return
        }

        ApplicationManager.getApplication().invokeLater {
            WriteCommandAction.runWriteCommandAction(project, "CodePilot Apply", null, {
                val vFile = findFile(filePath)
                if (vFile != null) {
                    val document = FileDocumentManager.getInstance().getDocument(vFile)
                    if (document != null) {
                        document.setText(code)
                        FileDocumentManager.getInstance().saveDocument(document)
                        log.info("Apply code block: replaced content in $filePath")
                    }
                } else {
                    val file = File(filePath)
                    file.parentFile?.mkdirs()
                    file.writeText(code)
                    log.info("Apply code block: created new file $filePath")
                }
            })
        }
    }

    private fun findFile(path: String): VirtualFile? {
        val file = File(path)
        if (!file.exists()) return null
        return LocalFileSystem.getInstance().findFileByIoFile(file)
    }
}