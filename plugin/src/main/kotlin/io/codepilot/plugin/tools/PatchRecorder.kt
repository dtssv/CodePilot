package io.codepilot.plugin.tools

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.fileEditor.FileDocumentManager
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * PatchRecorder — Records all patches applied by the Agent for one-click undo.
 *
 * For each Agent session, records every file edit as an inverse operation.
 * When the user clicks "Undo All", all recorded patches are replayed
 * in reverse order to restore the original state.
 */
class PatchRecorder(
    private val project: Project,
) {
    private val log = logger<PatchRecorder>()

    data class RecordedPatch(
        val id: String,
        val sessionId: String,
        val filePath: String,
        val operation: String,
        val oldContent: String?,
        val newContent: String?,
        val timestamp: String,
        val undone: Boolean = false,
    )

    private val sessions = ConcurrentHashMap<String, MutableList<RecordedPatch>>()

    fun record(
        sessionId: String,
        filePath: String,
        operation: String,
        oldContent: String?,
        newContent: String?,
    ): RecordedPatch {
        val patch = RecordedPatch(
            id = UUID.randomUUID().toString().take(8),
            sessionId = sessionId,
            filePath = filePath,
            operation = operation,
            oldContent = oldContent,
            newContent = newContent,
            timestamp = Instant.now().toString(),
        )
        sessions.computeIfAbsent(sessionId) { mutableListOf() }.add(patch)
        log.info("PatchRecorder: recorded $operation on $filePath (session=$sessionId)")
        return patch
    }

    fun undoAll(sessionId: String): Int {
        val patches = sessions[sessionId] ?: return 0
        val toUndo = patches.filter { !it.undone }.reversed()
        var undone = 0

        for (patch in toUndo) {
            try {
                undoPatch(patch)
                val idx = patches.indexOf(patch)
                if (idx >= 0) {
                    patches[idx] = patch.copy(undone = true)
                }
                undone++
            } catch (e: Exception) {
                log.error("PatchRecorder: failed to undo patch ${patch.id} on ${patch.filePath}", e)
            }
        }

        log.info("PatchRecorder: undid $undone/${toUndo.size} patches for session=$sessionId")
        return undone
    }

    /** Get the count of un-undone patches for a session. */
    fun getPatchCount(sessionId: String): Int {
        return sessions[sessionId]?.count { !it.undone } ?: 0
    }

    private fun undoPatch(patch: RecordedPatch) {
        ApplicationManager.getApplication().invokeLater {
            WriteCommandAction.runWriteCommandAction(project, "CodePilot Undo", null, {
                val vFile = findVirtualFile(patch.filePath) ?: run {
                    log.warn("PatchRecorder: file not found: ${patch.filePath}")
                    return@runWriteCommandAction
                }
                val document = FileDocumentManager.getInstance().getDocument(vFile)
                    ?: return@runWriteCommandAction

                when (patch.operation) {
                    "replace" -> {
                        if (patch.oldContent != null && patch.newContent != null) {
                            val currentText = document.text
                            if (currentText.contains(patch.newContent)) {
                                document.setText(currentText.replace(patch.newContent, patch.oldContent))
                            } else {
                                document.setText(patch.oldContent)
                            }
                        }
                    }
                    "write" -> {
                        document.setText(patch.oldContent ?: "")
                    }
                    "delete" -> {
                        if (patch.oldContent != null) {
                            document.setText(patch.oldContent)
                        }
                    }
                }
            })
        }
    }

    fun listPatches(sessionId: String): List<RecordedPatch> =
        sessions[sessionId]?.toList() ?: emptyList()

    fun undoableCount(sessionId: String): Int =
        sessions[sessionId]?.count { !it.undone } ?: 0

    fun clearSession(sessionId: String) {
        sessions.remove(sessionId)
    }

    private fun findVirtualFile(path: String): VirtualFile? {
        val file = java.io.File(path)
        if (!file.exists()) return null
        return LocalFileSystem.getInstance().findFileByIoFile(file)
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): PatchRecorder = project.getService(PatchRecorder::class.java)
    }
}