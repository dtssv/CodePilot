package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.plugin.settings.CodePilotSettings
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * Applies a Patch JSON returned in `final.patches[]` (or any `patch` SSE event). Each edit is
 * shown in the IntelliJ diff viewer for explicit user approval before being written via
 * [WriteCommandAction], unless the edit is low-risk and `auto-apply` is enabled in settings.
 */
class PatchApplier(
    private val project: Project,
) {
    private val auto = CodePilotSettings.getInstance().state.autoApplyLowRiskPatches

    // ★ Integration: PatchRecorder for batch undo, SmartMatcher for fuzzy path resolution,
    // ThreeWayMerger for conflict resolution
    private val recorder = PatchRecorder(project)
    private val matcher = SmartMatcher(project)
    private val merger = ThreeWayMerger(project)

    fun applyAll(patches: JsonNode) {
        if (patches.isMissingNode || !patches.isArray) return
        ApplicationManager.getApplication().invokeLater {
            patches.forEach { p ->
                runCatching { p.path("patches") }
                    .onSuccess { edits ->
                        if (edits.isArray) {
                            edits.forEach { applyEdit(it) }
                        } else {
                            applyEdit(p)
                        }
                    }
            }
        }
    }

    /**
     * Dispatch a named tool operation (fs.write, fs.replace, fs.delete, fs.move) through the
     * PatchApplier with DiffManager approval. Called from ToolDispatcher for mutating tools.
     */
    fun apply(
        toolName: String,
        args: JsonNode,
    ) {
        ApplicationManager.getApplication().invokeLater {
            when (toolName) {
                "fs.write" -> {
                    var rel = args.path("path").asText()
                    // ★ Integration: Use SmartMatcher for fuzzy path resolution
                    if (!resolveFile(rel)) {
                        val matched = matcher.matchFile(rel).firstOrNull()
                        if (matched != null && matched.score > 0.7) rel = matched.matched
                    }
                    val content = args.path("content").asText("")
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "write")
                            .put("path", rel)
                            .put("newContent", content)
                    applyEdit(edit)
                    // ★ Integration: Record patch for batch undo
                    recorder.record("current", rel, "write", null, content)
                }
                "fs.replace" -> {
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "replace")
                            .put("path", args.path("path").asText())
                            .put("search", args.path("search").asText())
                            .put("replace", args.path("replace").asText(""))
                            .put("regex", args.path("regex").asBoolean(false))
                            .put("ignoreCase", args.path("ignoreCase").asBoolean(false))
                    if (args.has("expectMatches")) edit.put("expectMatches", args.path("expectMatches").asInt())
                    applyEdit(edit)
                }
                "fs.delete" -> {
                    val rel = args.path("path").asText()
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "delete")
                            .put("path", rel)
                    applyEdit(edit)
                }
                "fs.move" -> {
                    val fromPath = args.path("from").asText()
                    val toPath = args.path("to").asText()
                    val updateRefs = args.path("updateReferences")?.asBoolean(true) ?: true
                    // Use IDEA's RefactoringElementFactory for safe move with reference updates
                    if (updateRefs) {
                        moveWithRefactoring(fromPath, toPath)
                    } else {
                        // Simple file move without reference update
                        val edit =
                            com.fasterxml.jackson.databind
                                .ObjectMapper()
                                .createObjectNode()
                                .put("op", "move")
                                .put("path", fromPath)
                                .put("to", toPath)
                        applyEdit(edit)
                    }
                }
                else -> throw ToolViolation("PatchApplier: unsupported tool $toolName")
            }
        }
    }

    /**
     * Apply a unified diff patch (as produced by the `ide.applyPatch` tool).
     * Parses the unified diff format and applies each hunk with DiffManager approval.
     */
    fun applyUnifiedPatch(patchText: String) {
        if (patchText.isBlank()) return
        ApplicationManager.getApplication().invokeLater {
            // Parse unified diff: extract file path and apply as a whole-file replace
            val lines = patchText.lines()
            var currentFile: String? = null
            val hunks = StringBuilder()

            for (line in lines) {
                when {
                    line.startsWith("+++ b/") || line.startsWith("+++ ") -> {
                        // Flush previous file if any
                        if (currentFile != null && hunks.isNotEmpty()) {
                            applyHunkToFile(currentFile!!, hunks.toString())
                            hunks.clear()
                        }
                        currentFile = line.removePrefix("+++ b/").removePrefix("+++ ").trim()
                    }
                    line.startsWith("--- ") -> { /* skip --- lines */ }
                    currentFile != null -> hunks.appendLine(line)
                }
            }
            // Apply last file
            if (currentFile != null && hunks.isNotEmpty()) {
                applyHunkToFile(currentFile!!, hunks.toString())
            }
        }
    }

    private fun applyHunkToFile(
        rel: String,
        patchContent: String,
    ) {
        try {
            val vf = PathGuard.resolve(project, rel)
            val original = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
            val patched = applyUnifiedHunks(original, patchContent)
            if (patched == original) return
            if (!confirmIfNeeded(rel, original, patched, "Apply patch to $rel")) return
            WriteCommandAction.runWriteCommandAction(project) {
                vf.setBinaryContent(patched.toByteArray(StandardCharsets.UTF_8))
            }
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to apply patch to $rel: ${e.message}", "CodePilot")
        }
    }

    private fun applyUnifiedHunks(
        original: String,
        hunkText: String,
    ): String {
        // Simple hunk applier: process +/- lines relative to original
        val origLines = original.lines().toMutableList()
        val hunkLines = hunkText.lines()
        val result = mutableListOf<String>()
        var origIdx = 0

        for (line in hunkLines) {
            when {
                line.startsWith("@@") -> {
                    // Parse @@ -start,count +start,count @@
                    val match = Regex("@@ -(\\d+)").find(line)
                    val targetLine = (match?.groupValues?.get(1)?.toIntOrNull() ?: 1) - 1
                    // Copy lines up to the hunk start
                    while (origIdx < targetLine && origIdx < origLines.size) {
                        result.add(origLines[origIdx++])
                    }
                }
                line.startsWith("-") -> origIdx++ // skip removed line
                line.startsWith("+") -> result.add(line.substring(1)) // add new line
                line.startsWith(" ") -> {
                    result.add(origLines.getOrElse(origIdx) { line.substring(1) })
                    origIdx++
                }
            }
        }
        // Copy remaining lines
        while (origIdx < origLines.size) {
            result.add(origLines[origIdx++])
        }
        return result.joinToString("\n")
    }

    /** Apply a single Edit object (per-file change). */
    fun applyEdit(edit: JsonNode) {
        val op = edit.path("op").asText()
        val rel = edit.path("path").asText()
        if (rel.isBlank()) return
        try {
            when (op) {
                "create" -> createFile(rel, edit)
                "write" -> writeFile(rel, edit)
                "replace" -> replaceFile(rel, edit)
                "delete" -> deleteFile(rel)
                "move" -> moveFile(rel, edit)
                else -> Messages.showWarningDialog(project, "Unknown patch op: $op", "CodePilot")
            }
        } catch (t: ToolViolation) {
            Messages.showErrorDialog(project, t.message ?: "patch rejected", "CodePilot")
        } catch (t: Throwable) {
            Messages.showErrorDialog(project, t.message ?: t.javaClass.simpleName, "CodePilot")
        }
    }

    /**
     * ★ Per-hunk selective apply: applies only the selected hunk indices from a unified diff.
     * Called from CefChatPanel when the user clicks "Apply" on individual hunks in the diff viewer.
     *
     * @param patchText   Full unified diff text
     * @param selectedHunks  0-based indices of hunks to apply (within each file)
     */
    fun applySelectedHunks(
        patchText: String,
        selectedHunks: Set<Int>,
    ) {
        if (patchText.isBlank() || selectedHunks.isEmpty()) return
        ApplicationManager.getApplication().invokeLater {
            val lines = patchText.lines()
            var currentFile: String? = null
            val hunksByFile = mutableMapOf<String, MutableList<String>>()
            var hunkIndex = -1

            for (line in lines) {
                when {
                    line.startsWith("+++ b/") || line.startsWith("+++ ") -> {
                        currentFile = line.removePrefix("+++ b/").removePrefix("+++ ").trim()
                        hunksByFile.getOrPut(currentFile!!) { mutableListOf() }
                    }
                    line.startsWith("--- ") -> { /* skip --- lines */ }
                    line.startsWith("@@") -> {
                        hunkIndex++
                        if (currentFile != null && hunkIndex in selectedHunks) {
                            hunksByFile[currentFile!!]!!.add(line)
                        }
                    }
                    currentFile != null && hunkIndex in selectedHunks -> {
                        hunksByFile[currentFile!!]!!.add(line)
                    }
                }
            }

            // Apply selected hunks per file
            for ((file, hunkLines) in hunksByFile) {
                if (hunkLines.isEmpty()) continue
                applyHunkToFile(file, hunkLines.joinToString("\n"))
            }
        }
    }

    // ----- per-op implementations (each performs guard + diff preview when applicable) -----

    private fun createFile(
        rel: String,
        edit: JsonNode,
    ) {
        val target = PathGuard.resolveOrCreate(project, rel)
        if (Files.exists(target) && !edit.path("overwrite").asBoolean(false)) {
            throw ToolViolation("create rejected; file already exists: $rel")
        }
        val newContent = edit.path("newContent").asText(edit.path("content").asText(""))
        if (!confirmIfNeeded(rel, "(new file)", newContent, "Create $rel")) return
        WriteCommandAction.runWriteCommandAction(project) {
            Files.createDirectories(target.parent)
            Files.writeString(target, newContent)
            refreshAt(target)
        }
    }

    private fun writeFile(
        rel: String,
        edit: JsonNode,
    ) {
        val vf = PathGuard.resolve(project, rel)
        val newContent = edit.path("newContent").asText(edit.path("content").asText(""))
        val original = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)

        // ★ Integration: Use ThreeWayMerger if file was modified since Agent last saw it
        val contentToApply = if (edit.has("baseContent")) {
            val baseContent = edit.path("baseContent").asText("")
            if (baseContent != original && baseContent.isNotBlank()) {
                // File was modified by user since Agent's base snapshot → 3-way merge
                val mergeResult = merger.merge(baseContent, original, newContent)
                if (mergeResult.hasConflicts) {
                    val proceed = Messages.showOkCancelDialog(
                        project,
                        "Merge conflict in $rel (${mergeResult.conflicts.size} conflict(s)). Apply with conflict markers?",
                        "CodePilot: Merge Conflict",
                        "Apply with Conflicts",
                        "Cancel",
                        Messages.getWarningIcon(),
                    )
                    if (proceed != Messages.OK) return
                }
                mergeResult.merged
            } else {
                newContent
            }
        } else {
            newContent
        }

        if (!confirmIfNeeded(rel, original, contentToApply, "Overwrite $rel")) return
        WriteCommandAction.runWriteCommandAction(project) {
            vf.setBinaryContent(contentToApply.toByteArray(StandardCharsets.UTF_8))
        }
        // ★ Integration: Record patch for batch undo via PatchRecorder
        recorder.record("current", rel, "write", original, contentToApply)
    }

    private fun replaceFile(
        rel: String,
        edit: JsonNode,
    ) {
        val vf = PathGuard.resolve(project, rel)
        val original = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
        val regex = edit.path("regex").asBoolean(false)
        val ignoreCase = edit.path("ignoreCase").asBoolean(false)
        val expectMatches = edit.path("expectMatches").asInt(-1)
        val search = edit.path("search").asText()
        val replace = edit.path("replace").asText("")
        if (search.isEmpty()) throw ToolViolation("empty search")

        val result = applyReplace(original, search, replace, regex, ignoreCase)
        if (expectMatches >= 0 && result.matches != expectMatches) {
            throw ToolViolation("expectMatches=$expectMatches but found ${result.matches}")
        }
        if (result.text == original) {
            Messages.showInfoMessage(project, "No occurrences of search pattern in $rel", "CodePilot")
            return
        }
        if (!confirmIfNeeded(rel, original, result.text, "Replace in $rel")) return
        WriteCommandAction.runWriteCommandAction(project) {
            vf.setBinaryContent(result.text.toByteArray(StandardCharsets.UTF_8))
        }
    }

    private fun deleteFile(rel: String) {
        val vf = PathGuard.resolve(project, rel)
        val ok =
            Messages.showOkCancelDialog(
                project,
                "Delete $rel? This moves the file to system Trash.",
                "CodePilot: Delete",
                "Delete",
                "Cancel",
                Messages.getWarningIcon(),
            )
        if (ok != Messages.OK) return
        WriteCommandAction.runWriteCommandAction(project) { vf.delete(this) }
    }

    private fun moveFile(
        rel: String,
        edit: JsonNode,
    ) {
        val src = PathGuard.resolve(project, rel)
        val to = edit.path("to").asText()
        if (to.isBlank()) throw ToolViolation("missing 'to' for move")
        val target = PathGuard.resolveOrCreate(project, to)
        val confirm =
            Messages.showOkCancelDialog(
                project,
                "Move $rel → $to ?",
                "CodePilot: Move",
                "Move",
                "Cancel",
                Messages.getQuestionIcon(),
            )
        if (confirm != Messages.OK) return
        WriteCommandAction.runWriteCommandAction(project) {
            Files.createDirectories(target.parent)
            val parent = LocalFileSystem.getInstance().refreshAndFindFileByPath(target.parent.toString())
            if (parent != null) src.move(this, parent)
            if (target.fileName.toString() != src.name) src.rename(this, target.fileName.toString())
        }
    }

    // ----- helpers -----

    private fun confirmIfNeeded(
        rel: String,
        before: String,
        after: String,
        title: String,
    ): Boolean {
        if (auto && before == after) return true
        return showDiff(rel, before, after, title)
    }

    private fun showDiff(
        rel: String,
        before: String,
        after: String,
        title: String,
    ): Boolean {
        val factory = DiffContentFactory.getInstance()
        val left = factory.create(before)
        val right = factory.create(after)
        val request = SimpleDiffRequest(title, left, right, "Original", "CodePilot")
        DiffManager.getInstance().showDiff(project, request)
        // showDiff is non-blocking; we ask the user explicitly with a follow-up dialog so that
        // the apply action remains under their control.
        val confirm =
            Messages.showOkCancelDialog(
                project,
                "Apply CodePilot's change to $rel?",
                "CodePilot",
                "Apply",
                "Reject",
                Messages.getQuestionIcon(),
            )
        return confirm == Messages.OK
    }

    private fun refreshAt(p: Path) {
        LocalFileSystem.getInstance().refreshAndFindFileByPath(p.toString())
    }

    /**
     * ★ Integration: Check if a file path exists in the project.
     * Used by SmartMatcher to determine if fuzzy matching is needed.
     */
    private fun resolveFile(rel: String): Boolean {
        return try {
            PathGuard.resolve(project, rel)
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * ★ Integration: Undo all recorded patches via PatchRecorder.
     * Replays inverse operations in reverse order.
     */
    fun undoAllRecorded(sessionId: String = "current") {
        val patchCount = recorder.getPatchCount(sessionId)
        if (patchCount == 0) return
        ApplicationManager.getApplication().invokeLater {
            val confirm = Messages.showOkCancelDialog(
                project,
                "Undo all $patchCount recorded change(s)?",
                "CodePilot: Undo All",
                "Undo All",
                "Cancel",
                Messages.getQuestionIcon(),
            )
            if (confirm != Messages.OK) return@invokeLater
            val undone = recorder.undoAll(sessionId)
            Messages.showInfoMessage(project, "Undid $undone change(s).", "CodePilot: Undo All")
        }
    }

    private data class ReplaceResult(
        val text: String,
        val matches: Int,
    )

    private fun applyReplace(
        original: String,
        search: String,
        replace: String,
        regex: Boolean,
        ignoreCase: Boolean,
    ): ReplaceResult {
        val pattern =
            if (regex) {
                Regex(search, if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet())
            } else {
                Regex(Regex.escape(search), if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet())
            }
        var count = 0
        val replaced =
            pattern.replace(original) { _ ->
                count++
                replace
            }
        return ReplaceResult(replaced, count)
    }

    // ─── Atomic Batch Apply + One-Click Undo (01-§3.21) ─────────────

    /**
     * Tracks all file snapshots before a batch apply, enabling one-click undo.
     * Key: relative file path, Value: original file content (null = file didn't exist)
     */
    private val batchSnapshots = mutableListOf<BatchSnapshot>()

    data class BatchSnapshot(
        val batchId: String,
        val path: String,
        val originalContent: String?,
        val timestamp: Long = System.currentTimeMillis(),
    )

    /**
     * Atomically apply a batch of edits in a single WriteCommandAction.
     * All edits are captured as snapshots for one-click undo via [undoLastBatch].
     *
     * Per 01-§3.21: "Agent 产出多文件 Patch 时，以统一的 Changes 面板展示，
     * 支持 per-hunk Accept/Reject，Accept 后走统一 WriteCommandAction 可一键撤销。"
     */
    fun applyAtomicBatch(
        edits: List<JsonNode>,
        onProgress: ((Int, Int) -> Unit)? = null,
    ) {
        if (edits.isEmpty()) return
        val batchId =
            java.util.UUID
                .randomUUID()
                .toString()

        ApplicationManager.getApplication().invokeLater {
            // Phase 1: Snapshot all original file contents
            val snapshots = mutableListOf<BatchSnapshot>()
            for (edit in edits) {
                val rel = edit.path("path").asText()
                if (rel.isBlank()) continue
                val originalContent =
                    try {
                        val vf = PathGuard.resolve(project, rel)
                        String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
                    } catch (_: Exception) {
                        null // File doesn't exist yet (create operation)
                    }
                snapshots.add(BatchSnapshot(batchId, rel, originalContent))
            }

            // Phase 2: Apply all edits in a single WriteCommandAction (atomic)
            WriteCommandAction.runWriteCommandAction(project, "CodePilot: Apply Batch", null, {
                for ((index, edit) in edits.withIndex()) {
                    try {
                        applyEditSilent(edit) // Apply without individual confirm dialogs
                        onProgress?.invoke(index + 1, edits.size)
                    } catch (e: Exception) {
                        // Roll back already-applied edits on failure
                        rollbackSnapshots(snapshots.subList(0, index))
                        Messages.showErrorDialog(project, "Batch apply failed at edit ${index + 1}: ${e.message}", "CodePilot")
                        return@runWriteCommandAction
                    }
                }
                // Phase 3: Store snapshots for undo
                batchSnapshots.addAll(snapshots)
            })
        }
    }

    /**
     * One-click undo for the last batch of changes.
     * Restores all files to their pre-batch state.
     */
    fun undoLastBatch() {
        if (batchSnapshots.isEmpty()) return
        val lastBatchId = batchSnapshots.last().batchId
        val toUndo = batchSnapshots.filter { it.batchId == lastBatchId }

        ApplicationManager.getApplication().invokeLater {
            val confirm =
                Messages.showOkCancelDialog(
                    project,
                    "Undo last batch (${toUndo.size} file(s))? This will restore all files to their state before the batch apply.",
                    "CodePilot: Undo Batch",
                    "Undo",
                    "Cancel",
                    Messages.getQuestionIcon(),
                )
            if (confirm != Messages.OK) return@invokeLater

            WriteCommandAction.runWriteCommandAction(project, "CodePilot: Undo Batch", null, {
                rollbackSnapshots(toUndo)
            })

            // Remove undone snapshots
            batchSnapshots.removeAll { it.batchId == lastBatchId }
        }
    }

    /** Check if there's a batch that can be undone. */
    fun hasUndoableBatch(): Boolean = batchSnapshots.isNotEmpty()

    /** Get the count of files in the last undoable batch. */
    fun lastBatchFileCount(): Int {
        if (batchSnapshots.isEmpty()) return 0
        val lastBatchId = batchSnapshots.last().batchId
        return batchSnapshots.count { it.batchId == lastBatchId }
    }

    private fun rollbackSnapshots(snapshots: List<BatchSnapshot>) {
        for (snapshot in snapshots.reversed()) {
            try {
                if (snapshot.originalContent == null) {
                    // File was created by the batch → delete it
                    val vf = PathGuard.resolve(project, snapshot.path)
                    vf.delete(this)
                } else {
                    // File was modified → restore original content
                    val vf = PathGuard.resolve(project, snapshot.path)
                    vf.setBinaryContent(snapshot.originalContent.toByteArray(StandardCharsets.UTF_8))
                }
            } catch (e: Exception) {
                // Best-effort rollback
            }
        }
    }

    /**
     * Apply a single edit without showing confirmation dialog.
     * Used by atomic batch apply where confirmation is done at the batch level.
     */
    private fun applyEditSilent(edit: JsonNode) {
        val op = edit.path("op").asText()
        val rel = edit.path("path").asText()
        if (rel.isBlank()) return

        when (op) {
            "create" -> {
                val target = PathGuard.resolveOrCreate(project, rel)
                val newContent = edit.path("newContent").asText(edit.path("content").asText(""))
                Files.createDirectories(target.parent)
                Files.writeString(target, newContent)
                refreshAt(target)
            }
            "write" -> {
                val vf = PathGuard.resolve(project, rel)
                val newContent = edit.path("newContent").asText(edit.path("content").asText(""))
                vf.setBinaryContent(newContent.toByteArray(StandardCharsets.UTF_8))
            }
            "replace" -> {
                val vf = PathGuard.resolve(project, rel)
                val original = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
                val search = edit.path("search").asText()
                val replace = edit.path("replace").asText("")
                val regex = edit.path("regex").asBoolean(false)
                val ignoreCase = edit.path("ignoreCase").asBoolean(false)
                val result = applyReplace(original, search, replace, regex, ignoreCase)
                vf.setBinaryContent(result.text.toByteArray(StandardCharsets.UTF_8))
            }
            "delete" -> {
                val vf = PathGuard.resolve(project, rel)
                vf.delete(this)
            }
        }
    }

    // ─── Post-Apply Compilation Feedback ──────────────────────────────

    /**
     * Apply a batch of edits and then automatically trigger a Shadow Workspace
     * compilation check. Returns validation result with any compilation errors.
     *
     * This provides immediate feedback after Diff application: if the applied
     * patches cause compilation errors, the user sees them right away and can
     * choose to undo the batch.
     */
    fun applyAndValidate(
        edits: List<JsonNode>,
        onProgress: ((Int, Int) -> Unit)? = null,
    ): ShadowWorkspace.ValidationResult? {
        // Apply the batch first
        applyAtomicBatch(edits, onProgress)

        // Build patch operations for Shadow Workspace validation
        val patchOps =
            edits.mapNotNull { edit ->
                val path = edit.path("path").asText().ifBlank { return@mapNotNull null }
                val op =
                    when (edit.path("op").asText("write")) {
                        "delete" -> "delete"
                        else -> if (edit.has("search")) "replace" else "create"
                    }
                val content = edit.path("newContent").asText(edit.path("content").asText(""))
                ShadowWorkspace.PatchOperation(path, op, content)
            }

        if (patchOps.isEmpty()) return null

        // Run Shadow Workspace validation
        val shadowWorkspace = ShadowWorkspace(project)
        return shadowWorkspace.validate(patchOps)
    }

    // ─── Move with Refactoring (Reference Update) ─────────────────────────

    /**
     * Move a file using IDEA's built-in MoveRefactoring to update all references.
     * Falls back to simple file move if refactoring is not available.
     *
     * This ensures that imports, usages, and other references to the moved file
     * are automatically updated across the entire project, matching IDEA's standard
     * refactoring behavior when a user manually moves a file.
     */
    private fun moveWithRefactoring(fromPath: String, toPath: String) {
        val fromVFile = PathGuard.resolve(project, fromPath)
        val fromPsi = com.intellij.psi.PsiManager.getInstance(project).findFile(fromVFile)
        if (fromPsi == null) {
            val edit = com.fasterxml.jackson.databind.ObjectMapper()
                .createObjectNode()
                .put("op", "move")
                .put("path", fromPath)
                .put("to", toPath)
            applyEdit(edit)
            return
        }

        // Resolve target directory path as java.nio.file.Path for filesystem operations
        val toNioPath = PathGuard.resolveOrCreate(project, toPath)
        val toDirNio = toNioPath.parent
        val toDirVFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
            .findFileByPath(toDirNio.toString())
            ?: run {
                java.nio.file.Files.createDirectories(toDirNio)
                com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                    .refreshAndFindFileByPath(toDirNio.toString())
            }

        if (toDirVFile != null) {
            val toDirPsi = com.intellij.psi.PsiManager.getInstance(project).findDirectory(toDirVFile)
            if (toDirPsi != null) {
                // Use IDEA's MoveFilesOrDirectoriesProcessor for safe move with reference updates
                ApplicationManager.getApplication().invokeLater {
                    val command = "CodePilot: Move $fromPath → $toPath"
                    WriteCommandAction.runWriteCommandAction(project, command, null, {
                        try {
                            // Move the file using IntelliJ's refactoring processor
                            // which automatically updates all references (imports, usages, etc.)
                            val moveProcessor = com.intellij.refactoring.move.moveFilesOrDirectories.MoveFilesOrDirectoriesProcessor(
                                project,
                                arrayOf(fromPsi),
                                toDirPsi,
                                true,  // searchForComments
                                true,  // searchInNonJavaFiles
                                null,  // listener
                                null,  // postProcessor
                            )
                            moveProcessor.run()

                            // Rename if target filename differs from source
                            val fromName = fromVFile.name
                            val toName = toNioPath.fileName.toString()
                            if (fromName != toName) {
                                // Refresh to find the moved file in its new location
                                LocalFileSystem.getInstance().refresh(true)
                                val movedVFile = LocalFileSystem.getInstance()
                                    .findFileByPath(toDirNio.resolve(fromName).toString())
                                if (movedVFile != null) {
                                    val movedPsi = com.intellij.psi.PsiManager.getInstance(project).findFile(movedVFile)
                                    if (movedPsi != null) {
                                        val renameProcessor = com.intellij.refactoring.rename.RenameProcessor(
                                            project, movedPsi, toName, false, false
                                        )
                                        renameProcessor.run()
                                    }
                                }
                            }

                            refreshAt(toNioPath)
                        } catch (e: Exception) {
                            // Fallback: simple move with content copy + reference search
                            performSimpleMoveWithReferenceUpdate(fromPath, toPath, fromPsi.text)
                        }
                    })
                }
                return
            }
        }

        // Final fallback: simple move
        val edit = com.fasterxml.jackson.databind.ObjectMapper()
            .createObjectNode()
            .put("op", "move")
            .put("path", fromPath)
            .put("to", toPath)
        applyEdit(edit)
    }

    /**
     * Fallback move: copy content to target, delete source, then update references
     * by searching for old import statements across the project.
     */
    private fun performSimpleMoveWithReferenceUpdate(fromPath: String, toPath: String, content: String) {
        // 1. Create target file with content
        val targetNioPath = PathGuard.resolveOrCreate(project, toPath)
        java.nio.file.Files.createDirectories(targetNioPath.parent)
        java.nio.file.Files.writeString(targetNioPath, content)

        // 2. Delete source file
        val sourceNioPath = PathGuard.resolveOrCreate(project, fromPath)
        java.nio.file.Files.deleteIfExists(sourceNioPath)

        // 3. Refresh VFS
        refreshAt(targetNioPath)
        com.intellij.openapi.vfs.LocalFileSystem.getInstance().refresh(true)

        // 4. Update references: search for old import statements and replace
        val oldPkg = fromPath.replace('/', '.').removeSuffix(".java").removeSuffix(".kt")
        val newPkg = toPath.replace('/', '.').removeSuffix(".java").removeSuffix(".kt")
        val oldImport = "import $oldPkg"
        val newImport = "import $newPkg"

        // Update references: search for old import statements and replace
        // Use simple file-based search approach to find and update import references
        val scope = com.intellij.psi.search.GlobalSearchScope.projectScope(project)
        val searchHelper = com.intellij.psi.search.PsiSearchHelper.getInstance(project)
        val shortName = oldPkg.substringAfterLast('.')

        // Search for files containing the old class name and update imports
        val processor = com.intellij.util.Processor<com.intellij.psi.PsiFile> { psiFile ->
            val text = psiFile.text
            if (text.contains(oldImport)) {
                val updated = text.replace(oldImport, newImport)
                val vFile = psiFile.virtualFile
                if (vFile != null) {
                    ApplicationManager.getApplication().invokeLater {
                        WriteCommandAction.runWriteCommandAction(project) {
                            vFile.setBinaryContent(updated.toByteArray(StandardCharsets.UTF_8))
                        }
                    }
                }
            }
            true
        }
        // processAllFilesWithWord(word, scope, processor, caseSensitive)
        searchHelper.processAllFilesWithWord(shortName, scope, processor, true)
    }
}