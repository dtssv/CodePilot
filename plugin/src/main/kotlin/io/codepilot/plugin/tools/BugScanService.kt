package io.codepilot.plugin.tools

import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import java.nio.charset.StandardCharsets

/**
 * ★ BugScanService: Background scanning service that collects IDE diagnostics
 * and prepares them for the Bug Finder action.
 *
 * This runs on-demand (triggered by the bug-scan action) or can be configured
 * to run periodically for proactive bug detection.
 */
class BugScanService(
    private val project: Project,
) {
    private val log = Logger.getInstance(BugScanService::class.java)

    data class Diagnostic(
        val filePath: String,
        val line: Int,
        val severity: String,
        val message: String,
        val source: String, // "ide" or "llm"
    )

    data class ScanResult(
        val diagnostics: List<Diagnostic>,
        val fileCount: Int,
        val durationMs: Long,
    )

    /**
     * Scan a single file for IDE diagnostics.
     */
    fun scanFile(filePath: String): ScanResult {
        val startTime = System.currentTimeMillis()
        val diagnostics = mutableListOf<Diagnostic>()

        ApplicationManager.getApplication().runReadAction {
            try {
                val vf = PathGuard.resolve(project, filePath)
                val doc = FileDocumentManager.getInstance().getDocument(vf) ?: return@runReadAction

                val highlights = DaemonCodeAnalyzerImpl.getHighlights(doc, null, project)
                for (h in highlights) {
                    diagnostics.add(
                        Diagnostic(
                            filePath = filePath,
                            line = doc.getLineNumber(h.startOffset) + 1,
                            severity = h.severity.name,
                            message = h.description ?: "",
                            source = "ide",
                        ),
                    )
                }
            } catch (e: Exception) {
                log.warn("Failed to scan file: $filePath", e)
            }
        }

        return ScanResult(
            diagnostics = diagnostics,
            fileCount = 1,
            durationMs = System.currentTimeMillis() - startTime,
        )
    }

    /**
     * Scan all open editor files for diagnostics.
     */
    fun scanOpenFiles(): ScanResult {
        val startTime = System.currentTimeMillis()
        val diagnostics = mutableListOf<Diagnostic>()

        ApplicationManager.getApplication().runReadAction {
            val editors =
                com.intellij.openapi.fileEditor.FileEditorManager
                    .getInstance(project)
                    .openFiles
            for (vf in editors) {
                try {
                    val doc = FileDocumentManager.getInstance().getDocument(vf) ?: continue
                    val rel = vf.path.removePrefix(PathGuard.projectRoot(project).path).trimStart('/')
                    val highlights = DaemonCodeAnalyzerImpl.getHighlights(doc, null, project)
                    for (h in highlights) {
                        diagnostics.add(
                            Diagnostic(
                                filePath = rel,
                                line = doc.getLineNumber(h.startOffset) + 1,
                                severity = h.severity.name,
                                message = h.description ?: "",
                                source = "ide",
                            ),
                        )
                    }
                } catch (e: Exception) {
                    log.warn("Failed to scan open file", e)
                }
            }
        }

        return ScanResult(
            diagnostics = diagnostics,
            fileCount =
                com.intellij.openapi.fileEditor.FileEditorManager
                    .getInstance(project)
                    .openFiles.size,
            durationMs = System.currentTimeMillis() - startTime,
        )
    }

    /**
     * Get the file content and diagnostics for bug-scan action request.
     */
    fun prepareBugScanPayload(filePath: String): Map<String, Any?>? =
        ApplicationManager.getApplication().runReadAction<Map<String, Any?>?> {
            try {
                val vf = PathGuard.resolve(project, filePath)
                val content = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
                val scanResult = scanFile(filePath)
                mapOf(
                    "code" to content,
                    "filePath" to filePath,
                    "language" to vf.fileType.name.lowercase(),
                    "diagnostics" to
                        scanResult.diagnostics.map { d ->
                            "[${d.severity}] Line ${d.line}: ${d.message}"
                        },
                )
            } catch (e: Exception) {
                log.warn("Failed to prepare bug scan payload for: $filePath", e)
                null
            }
        }
}
