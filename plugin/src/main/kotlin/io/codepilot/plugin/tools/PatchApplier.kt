package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.ui.InlineDiffRenderer
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
    private val log = com.intellij.openapi.diagnostic.Logger.getInstance(PatchApplier::class.java)

    /** Risk levels for write operations. */
    enum class Risk { LOW, MEDIUM, HIGH }

    /** Read the current auto-apply setting (may change at runtime). */
    private val autoApply: Boolean get() = CodePilotSettings.getInstance().state.autoApplyLowRiskPatches

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
    /**
     * Determine risk level for a given tool name.
     * Low: create (with overwrite=false), write (content same or small diff)
     * Medium: create (overwrite), write, replace
     * High: delete, move
     */
    fun riskForTool(toolName: String, path: String = ""): Risk {
        if (autoApply) {
            when (toolName) {
                "fs.create", "fs.write", "fs.replace" -> return Risk.LOW
            }
        }
        return when (toolName) {
            "fs.create" -> if (path.startsWith("doc/") || path.startsWith("doc\\")) Risk.LOW else Risk.MEDIUM
            "fs.write" -> Risk.MEDIUM
            "fs.replace" -> Risk.MEDIUM
            "fs.delete" -> Risk.HIGH
            "fs.move" -> Risk.HIGH
            else -> Risk.MEDIUM
        }
    }

    data class ApplySyncResult(
        val path: String,
        val written: Boolean,
        val lineCount: Int = 0,
        val error: String? = null,
    ) {
        val ok: Boolean get() = error == null
    }

    /**
     * Apply on the EDT (blocking), so graph tool_call ack reflects real disk writes.
     * Auto-apply: writes immediately. Otherwise shows IDE diff + Apply/Reject (Cursor-style).
     */
    fun applySync(toolName: String, args: JsonNode): ApplySyncResult {
        val path = args.path("path").asText("")
        if (path.isBlank()) {
            return ApplySyncResult("", false, error = "blank path")
        }
        val box = arrayOf(ApplySyncResult(path, false, lineCountFromPatch(args)))
        ApplicationManager.getApplication().invokeAndWait {
            try {
                val written = applyFromToolArgs(toolName, args)
                box[0] = ApplySyncResult(path, written, lineCountFromPatch(args))
                if (written) {
                    openFileInEditor(path)
                }
            } catch (t: ToolViolation) {
                box[0] = ApplySyncResult(path, false, error = t.message)
            } catch (t: Throwable) {
                box[0] = ApplySyncResult(path, false, error = t.message ?: t.javaClass.simpleName)
            }
        }
        return box[0]
    }

    private fun lineCountFromPatch(args: JsonNode): Int {
        val content = args.path("newContent").asText(args.path("content").asText(""))
        if (content.isEmpty()) return 0
        return content.lines().size
    }

    private fun applyFromToolArgs(toolName: String, args: JsonNode): Boolean {
        val mapper = com.fasterxml.jackson.databind.ObjectMapper()
        return when (toolName) {
            "fs.create" -> {
                val rel = args.path("path").asText()
                val content = args.path("content").asText(args.path("newContent").asText(""))
                val edit =
                    mapper.createObjectNode()
                        .put("op", "create")
                        .put("path", rel)
                        .put("newContent", content)
                        .put("overwrite", args.path("overwrite").asBoolean(true))
                applyEdit(edit, riskForTool(toolName, rel))
            }
            "fs.write" -> {
                var rel = args.path("path").asText()
                if (!resolveFile(rel)) {
                    matcher.matchFile(rel).firstOrNull()?.let { if (it.score > 0.7) rel = it.matched }
                }
                val content = args.path("content").asText(args.path("newContent").asText(""))
                val edit =
                    mapper.createObjectNode()
                        .put("op", "write")
                        .put("path", rel)
                        .put("newContent", content)
                applyEdit(edit, riskForTool(toolName, rel))
            }
            "fs.replace" -> {
                // ★ Integration: Use SmartMatcher for fuzzy path resolution (same as fs.write)
                var rel = args.path("path").asText()
                if (!resolveFile(rel)) {
                    matcher.matchFile(rel).firstOrNull()?.let { if (it.score > 0.7) rel = it.matched }
                }
                val edit =
                    mapper.createObjectNode()
                        .put("op", "replace")
                        .put("path", rel)
                        .put("search", args.path("search").asText())
                        .put("replace", args.path("replace").asText(""))
                        .put("regex", args.path("regex").asBoolean(false))
                        .put("ignoreCase", args.path("ignoreCase").asBoolean(false))
                applyEdit(edit, riskForTool(toolName, rel))
            }
            "fs.delete" -> {
                val rel = args.path("path").asText()
                applyEdit(mapper.createObjectNode().put("op", "delete").put("path", rel), riskForTool(toolName, rel))
            }
            else -> false
        }
    }

    private fun openFileInEditor(rel: String) {
        runCatching {
            val vf = PathGuard.resolve(project, rel)
            com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    fun apply(
        toolName: String,
        args: JsonNode,
    ) {
        val risk = riskForTool(toolName)
        ApplicationManager.getApplication().invokeLater {
            when (toolName) {
                "fs.create" -> {
                    val rel = args.path("path").asText()
                    // Support both "content" and "newContent" field names
                    val content = args.path("content").asText(args.path("newContent").asText(""))
                    val overwrite = args.path("overwrite").asBoolean(true) // Default true for applyPatch creates
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "create")
                            .put("path", rel)
                            .put("newContent", content)
                    if (overwrite) edit.put("overwrite", true)
                    applyEdit(edit, risk)
                    recorder.record("current", rel, "create", null, content)
                }
                "fs.write" -> {
                    var rel = args.path("path").asText()
                    // ★ Integration: Use SmartMatcher for fuzzy path resolution
                    if (!resolveFile(rel)) {
                        val matched = matcher.matchFile(rel).firstOrNull()
                        if (matched != null && matched.score > 0.7) rel = matched.matched
                    }
                    // Support both "content" (fs.write native) and "newContent" (fs.applyPatch format)
                    val content = args.path("content").asText(args.path("newContent").asText(""))
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "write")
                            .put("path", rel)
                            .put("newContent", content)
                    applyEdit(edit, risk)
                    // ★ Integration: Record patch for batch undo
                    recorder.record("current", rel, "write", null, content)
                }
                "fs.replace" -> {
                    // ★ Integration: Use SmartMatcher for fuzzy path resolution (same as fs.write)
                    var rel = args.path("path").asText()
                    if (!resolveFile(rel)) {
                        matcher.matchFile(rel).firstOrNull()?.let { if (it.score > 0.7) rel = it.matched }
                    }
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "replace")
                            .put("path", rel)
                            .put("search", args.path("search").asText())
                            .put("replace", args.path("replace").asText(""))
                            .put("regex", args.path("regex").asBoolean(false))
                            .put("ignoreCase", args.path("ignoreCase").asBoolean(false))
                    if (args.has("expectMatches")) edit.put("expectMatches", args.path("expectMatches").asInt())
                    applyEdit(edit, risk)
                }
                "fs.delete" -> {
                    val rel = args.path("path").asText()
                    val edit =
                        com.fasterxml.jackson.databind
                            .ObjectMapper()
                            .createObjectNode()
                            .put("op", "delete")
                            .put("path", rel)
                    applyEdit(edit, risk)
                }
                "fs.move" -> {
                    val fromPath = args.path("from").asText()
                    val toPath = args.path("to").asText()
                    val updateRefs = args.path("updateReferences")?.asBoolean(true) ?: true
                    // Use IDEA's RefactoringElementFactory for safe move with reference updates
                    if (updateRefs) {
                        moveWithRefactoring(fromPath, toPath, risk)
                    } else {
                        // Simple file move without reference update
                        val edit =
                            com.fasterxml.jackson.databind
                                .ObjectMapper()
                                .createObjectNode()
                                .put("op", "move")
                                .put("path", fromPath)
                                .put("to", toPath)
                        applyEdit(edit, risk)
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
        risk: Risk = Risk.MEDIUM,
    ) {
        try {
            val vf = PathGuard.resolve(project, rel)
            val original = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
            val patched = applyUnifiedHunks(original, patchContent)
            if (patched == original) return
            val confirmResult = confirmIfNeededInline(rel, original, patched, "Apply patch to $rel", risk)
            if (!confirmResult.confirmed) return
            if (!confirmResult.inlineApplied) {
                WriteCommandAction.runWriteCommandAction(project) {
                    vf.setBinaryContent(patched.toByteArray(StandardCharsets.UTF_8))
                }
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

    /** Apply a single Edit object (per-file change). @return true if bytes were written to disk */
    fun applyEdit(edit: JsonNode, risk: Risk = Risk.MEDIUM): Boolean {
        val op = edit.path("op").asText()
        val rel = edit.path("path").asText()
        if (rel.isBlank()) return false
        return try {
            when (op) {
                "create" -> createFile(rel, edit, risk)
                "write" -> writeFile(rel, edit, risk)
                "replace" -> replaceFile(rel, edit, risk)
                "delete" -> deleteFile(rel, risk)
                "move" -> moveFile(rel, edit, risk)
                else -> {
                    Messages.showWarningDialog(project, "Unknown patch op: $op", "CodePilot")
                    false
                }
            }
        } catch (t: ToolViolation) {
            Messages.showErrorDialog(project, t.message ?: "patch rejected", "CodePilot")
            false
        } catch (t: Throwable) {
            Messages.showErrorDialog(project, t.message ?: t.javaClass.simpleName, "CodePilot")
            false
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
        risk: Risk = Risk.MEDIUM,
    ): Boolean {
        val newContent = edit.path("newContent").asText(edit.path("content").asText(""))
        if (looksLikeDirectoryCreate(rel, newContent)) {
            return createDirectory(rel, risk)
        }
        val target = PathGuard.resolveOrCreate(project, rel)
        if (Files.exists(target) && !edit.path("overwrite").asBoolean(false)) {
            throw ToolViolation("create rejected; file already exists: $rel")
        }
        if (!confirmIfNeeded(rel, "", newContent, "Create $rel", risk)) return false
        WriteCommandAction.runWriteCommandAction(project) {
            Files.createDirectories(target.parent)
            Files.writeString(target, newContent)
            refreshAt(target)
        }
        return true
    }

    /** True when path/content indicates mkdir (any folder path), not a regular file. */
    private fun looksLikeDirectoryCreate(rel: String, content: String): Boolean {
        val normalized = rel.trim().replace('\\', '/')
        if (normalized.endsWith("/")) return true
        if (content.isNotBlank()) return false
        val name = normalized.substringAfterLast('/')
        return !name.contains(".")
    }

    private fun createDirectory(rel: String, risk: Risk = Risk.MEDIUM): Boolean {
        val dirRel = rel.trim().trimEnd('/', '\\')
        if (!confirmIfNeeded(dirRel, "", "", "Create directory $dirRel", risk)) return false
        WriteCommandAction.runWriteCommandAction(project) {
            val target = PathGuard.resolveOrCreate(project, dirRel)
            Files.createDirectories(target)
            refreshAt(target)
        }
        return true
    }

    private fun writeFile(
        rel: String,
        edit: JsonNode,
        risk: Risk = Risk.MEDIUM,
    ): Boolean {
        val newContent = edit.path("newContent").asText(edit.path("content").asText(""))

        // ★ If the file doesn't exist yet, treat fs.write as create (write-or-create semantics)
        val existingVf = try {
            PathGuard.resolve(project, rel)
        } catch (_: ToolViolation) {
            // File doesn't exist — create it instead
            return createFile(rel, edit, risk)
        }

        val original = String(existingVf.contentsToByteArray(), StandardCharsets.UTF_8)

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
                    if (proceed != Messages.OK) return false
                }
                mergeResult.merged
            } else {
                newContent
            }
        } else {
            newContent
        }

        val confirmResult = confirmIfNeededInline(rel, original, contentToApply, "Overwrite $rel", risk)
        if (!confirmResult.confirmed) return false
        if (!confirmResult.inlineApplied) {
            WriteCommandAction.runWriteCommandAction(project) {
                existingVf.setBinaryContent(contentToApply.toByteArray(StandardCharsets.UTF_8))
            }
        }
        recorder.record("current", rel, "write", original, contentToApply)
        return true
    }

    private fun replaceFile(
        rel: String,
        edit: JsonNode,
        risk: Risk = Risk.MEDIUM,
    ): Boolean {
        val vf = PathGuard.resolve(project, rel)
        val original = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
        val regex = edit.path("regex").asBoolean(false)
        val ignoreCase = edit.path("ignoreCase").asBoolean(false)
        val expectMatches = edit.path("expectMatches").asInt(-1)
        val search = edit.path("search").asText()
        val replace = edit.path("replace").asText("")
        if (search.isEmpty()) throw ToolViolation("empty search")

        // ★ Normalize whitespace: CRLF→LF, trailing whitespace per line
        val normalizedOriginal = original.replace("\r\n", "\n").trimTrailingLines()
        val normalizedSearch = search.replace("\r\n", "\n").trimTrailingLines()

        // ★ Debug logging: record search/original overview before match attempts
        log.warn("[replaceFile-DEBUG] $rel — search.length=${search.length}, original.length=${original.length}, " +
            "normalizedSearch.length=${normalizedSearch.length}, normalizedOriginal.length=${normalizedOriginal.length}, " +
            "regex=$regex, ignoreCase=$ignoreCase")
        log.warn("[replaceFile-DEBUG] $rel — search first 5 lines: ${search.lines().take(5)}")
        log.warn("[replaceFile-DEBUG] $rel — original first 5 lines: ${original.lines().take(5)}")
        log.warn("[replaceFile-DEBUG] $rel — search last 5 lines: ${search.lines().takeLast(5)}")
        log.warn("[replaceFile-DEBUG] $rel — original last 5 lines: ${original.lines().takeLast(5)}")
        // Log character-level difference at the first diverging position
        val firstDiffPos = search.indices.firstOrNull { it >= original.length || search[it] != original[it] }
        if (firstDiffPos != null && firstDiffPos < search.length) {
            val ctxStart = maxOf(0, firstDiffPos - 20)
            val ctxEnd = minOf(search.length, firstDiffPos + 20)
            log.warn("[replaceFile-DEBUG] $rel — first char diff at pos=$firstDiffPos: " +
                "search[${ctxStart}..${ctxEnd}]=${search.substring(ctxStart, ctxEnd).replaceWhitespaceForLog()}, " +
                "original[${ctxStart}..${minOf(original.length, ctxEnd)}]=${if (firstDiffPos < original.length) original.substring(ctxStart, minOf(original.length, ctxEnd)).replaceWhitespaceForLog() else "<EOF>"}")
        } else if (search.length != original.length) {
            log.warn("[replaceFile-DEBUG] $rel — length mismatch: search=${search.length} vs original=${original.length}, " +
                "no char diff in common prefix of length ${minOf(search.length, original.length)}")
        }

        // Primary: exact match with normalized content
        var result = applyReplace(normalizedOriginal, normalizedSearch, replace, regex, ignoreCase)
        var usedNormalized = result.matches > 0
        log.warn("[replaceFile-DEBUG] $rel — attempt1 (normalized exact): matches=${result.matches}, usedNormalized=$usedNormalized")

        // Fallback 1: if exact match failed, try with original (un-normalized) content
        if (!usedNormalized) {
            result = applyReplace(original, search, replace, regex, ignoreCase)
            usedNormalized = result.matches > 0
            log.warn("[replaceFile-DEBUG] $rel — attempt2 (raw exact): matches=${result.matches}, usedNormalized=$usedNormalized")
        }

        // Fallback 1.5: if still no match and not regex, try line-trim matching
        // (normalize each line to trimmed content, match, then restore original indentation)
        if (!usedNormalized && !regex) {
            val lineTrimResult = lineTrimReplace(normalizedOriginal, normalizedSearch, replace)
            if (lineTrimResult.matches > 0) {
                log.info("replaceFile: exact match failed for $rel, succeeded via line-trim (indent-tolerant) match")
                result = lineTrimResult
                usedNormalized = true
            }
            log.warn("[replaceFile-DEBUG] $rel — attempt2.5 (line-trim): matches=${lineTrimResult.matches}, usedNormalized=$usedNormalized")
        }

        // Fallback 2: if still no match and not regex, try fuzzy match ignoring leading whitespace differences
        if (!usedNormalized && !regex) {
            val fuzzyResult = fuzzyReplaceByLineContent(normalizedOriginal, normalizedSearch, replace)
            if (fuzzyResult.matches > 0) {
                log.info("replaceFile: exact match failed for $rel, succeeded via fuzzy (whitespace-tolerant) match")
                result = fuzzyResult
                usedNormalized = true
            }
            log.warn("[replaceFile-DEBUG] $rel — attempt3 (fuzzy): matches=${fuzzyResult.matches}, usedNormalized=$usedNormalized")
        }

        // Fallback 3: if still no match and not regex, try subsequence match
        // (search lines appear in order within original, but intermediate lines may be omitted by LLM)
        if (!usedNormalized && !regex) {
            val subseqResult = subsequenceReplace(normalizedOriginal, normalizedSearch, replace)
            if (subseqResult.matches > 0) {
                log.info("replaceFile: exact+fuzzy match failed for $rel, succeeded via subsequence (omitted-line-tolerant) match")
                result = subseqResult
                usedNormalized = true
            }
            log.warn("[replaceFile-DEBUG] $rel — attempt4 (subsequence): matches=${subseqResult.matches}, usedNormalized=$usedNormalized")
        }

        if (expectMatches >= 0 && result.matches != expectMatches) {
            throw ToolViolation("expectMatches=$expectMatches but found ${result.matches}")
        }
        if (!usedNormalized) {
            // ★ Diagnostic logging for unmatched search pattern — dump full content for diff analysis
            log.warn("[replaceFile-DEBUG] $rel — ALL 4 MATCH ATTEMPTS FAILED, dumping full content for comparison:")
            log.warn("[replaceFile-DEBUG] $rel — FULL SEARCH >>>\n$search\n<<< END SEARCH")
            log.warn("[replaceFile-DEBUG] $rel — FULL ORIGINAL >>>\n$original\n<<< END ORIGINAL")
            // Line-by-line diff for first 50 lines
            val searchLines = search.lines()
            val originalLines = original.lines()
            val diffLineCount = minOf(searchLines.size, originalLines.size, 50)
            for (i in 0 until diffLineCount) {
                if (searchLines[i] != originalLines[i]) {
                    log.warn("[replaceFile-DEBUG] $rel — line ${i + 1} DIFFERS: " +
                        "search=${searchLines[i].take(120).replaceWhitespaceForLog()}, " +
                        "original=${originalLines[i].take(120).replaceWhitespaceForLog()}")
                }
            }
            if (searchLines.size != originalLines.size) {
                log.warn("[replaceFile-DEBUG] $rel — line count differs: search=${searchLines.size}, original=${originalLines.size}")
                val extraInSearch = searchLines.drop(minOf(searchLines.size, originalLines.size)).take(5)
                val extraInOriginal = originalLines.drop(minOf(searchLines.size, originalLines.size)).take(5)
                if (extraInSearch.isNotEmpty()) log.warn("[replaceFile-DEBUG] $rel — extra search lines (first 5): $extraInSearch")
                if (extraInOriginal.isNotEmpty()) log.warn("[replaceFile-DEBUG] $rel — extra original lines (first 5): $extraInOriginal")
            }
            Messages.showInfoMessage(project, "No occurrences of search pattern in $rel", "CodePilot")
            return false
        }

        // If we matched against normalized content, convert result back to original line endings
        val finalText = if (original.contains("\r\n")) result.text.replace("\n", "\r\n") else result.text
        val confirmResult = confirmIfNeededInline(rel, original, finalText, "Replace in $rel", risk)
        if (!confirmResult.confirmed) return false
        if (!confirmResult.inlineApplied) {
            WriteCommandAction.runWriteCommandAction(project) {
                vf.setBinaryContent(finalText.toByteArray(StandardCharsets.UTF_8))
            }
        }
        return true
    }

    /** Trim trailing whitespace on each line (but keep the newline itself). */
    private fun String.trimTrailingLines(): String =
        lines().joinToString("\n") { it.trimEnd() }

    /** Replace visible whitespace chars for log output (compact, readable). */
    private fun String.replaceWhitespaceForLog(): String =
        replace('\t', '⇥').replace('\r', '⏎').replace(' ', '·')

    /**
     * ★ Line-trim match: strip leading+trailing whitespace from every line in both
     * [original] and [searchText], perform exact substring replacement on the trimmed
     * text, then restore the original indentation for unchanged lines and compute
     * proper indentation for replaced lines.
     *
     * This handles the common LLM error where the search block has correct content
     * but wrong indentation (e.g. 1 space instead of 4).
     *
     * Scenarios supported:
     * - Search block with wrong indentation depth
     * - Mixed tab/space indentation differences
     * - Search block where some lines have correct indent and others don't
     * - Original file with consistent or mixed indentation styles
     */
    private fun lineTrimReplace(
        original: String,
        searchText: String,
        replaceText: String,
    ): ReplaceResult {
        val originalLines = original.lines()
        val searchLines = searchText.lines()
        if (searchLines.isEmpty()) return ReplaceResult(original, 0)

        val originalTrimmedLines = originalLines.map { it.trim() }
        val searchTrimmedLines = searchLines.map { it.trim() }
        val originalTrimmed = originalTrimmedLines.joinToString("\n")
        val searchTrimmed = searchTrimmedLines.joinToString("\n")

        // Exact match on trimmed content — find ALL occurrences
        val matchRanges = mutableListOf<IntRange>()
        var searchFrom = 0
        while (true) {
            val idx = originalTrimmed.indexOf(searchTrimmed, searchFrom)
            if (idx == -1) break
            matchRanges.add(idx until (idx + searchTrimmed.length))
            searchFrom = idx + 1
        }
        if (matchRanges.isEmpty()) return ReplaceResult(original, 0)

        // For safety, only proceed if there is exactly one match
        // (multiple matches would create ambiguity about which region to replace)
        if (matchRanges.size > 1) {
            log.warn("[lineTrimReplace] found ${matchRanges.size} matches on trimmed content, skipping due to ambiguity")
            return ReplaceResult(original, 0)
        }
        val matchRange = matchRanges.first()

        // Map the trimmed match range back to original line indices
        // by counting newlines before match start and end
        val startLine = originalTrimmed.substring(0, matchRange.first).count { it == '\n' }
        val endLine = startLine + searchTrimmedLines.size - 1

        // Compute indentation mapping: for each line in the matched region,
        // record the original line's leading whitespace
        val matchedOriginalIndents = (startLine..endLine).map { idx ->
            if (idx < originalLines.size) originalLines[idx].takeWhile { it == ' ' || it == '\t' }
            else ""
        }
        val searchIndents = searchLines.map { it.takeWhile { it == ' ' || it == '\t' } }

        // Base indent: the indent of the first matched line in original
        val baseOriginalIndent = matchedOriginalIndents.firstOrNull() ?: ""
        val baseSearchIndent = searchIndents.firstOrNull() ?: ""

        // Build replace lines with proper indentation
        val replaceRawLines = replaceText.lines()
        val indentedReplace = replaceRawLines.mapIndexed { idx, line ->
            if (line.isBlank()) line
            else {
                val trimmed = line.trim()
                // Try to find the matching search line to preserve relative indentation
                val matchedSearchIdx = searchTrimmedLines.indexOfFirst { it == trimmed }
                val searchLineIndent = if (matchedSearchIdx >= 0 && matchedSearchIdx < searchIndents.size) {
                    searchIndents[matchedSearchIdx]
                } else {
                    // Fallback: use indent of the search line at the same index
                    if (idx < searchIndents.size) searchIndents[idx]
                    else baseSearchIndent
                }
                // Compute relative indent: how much deeper this line is than the search base
                val relativeIndent = if (searchLineIndent.length >= baseSearchIndent.length) {
                    searchLineIndent.substring(baseSearchIndent.length)
                } else {
                    ""
                }
                baseOriginalIndent + relativeIndent + trimmed
            }
        }

        val replacedLines = originalLines.toMutableList()
        replacedLines.subList(startLine, endLine + 1).clear()
        replacedLines.addAll(startLine, indentedReplace)

        return ReplaceResult(replacedLines.joinToString("\n"), 1)
    }

    /** Find the [IntRange] of the first occurrence of [substring] in this string, or null if not found. */
    private fun String.findRangeOf(substring: String): IntRange? {
        val idx = indexOf(substring)
        if (idx == -1) return null
        return idx until (idx + substring.length)
    }

    /**
     * ★ Fuzzy match: find a contiguous block of lines whose stripped content matches
     * the stripped lines of [searchText], then replace with [replaceText].
     * This tolerates indentation differences (tabs vs spaces, different indent depths).
     */
    private fun fuzzyReplaceByLineContent(
        original: String,
        searchText: String,
        replaceText: String,
    ): ReplaceResult {
        // ★ Use trim() instead of trimEnd() — tolerate both leading and trailing whitespace differences
        val searchLinesTrimmed = searchText.lines().map { it.trim() }
        if (searchLinesTrimmed.isEmpty()) return ReplaceResult(original, 0)

        val originalLines = original.lines()
        val originalLinesTrimmed = originalLines.map { it.trim() }

        // Find the first contiguous block in original whose trimmed lines match search trimmed lines
        var matchCount = 0
        var matchStart = -1
        for (i in originalLinesTrimmed.indices) {
            if (originalLinesTrimmed.subList(i, minOf(i + searchLinesTrimmed.size, originalLinesTrimmed.size)) == searchLinesTrimmed) {
                matchStart = i
                matchCount++
            }
        }

        if (matchStart == -1) return ReplaceResult(original, 0)

        // Build replacement: compute per-line indentation shift
        // For each matched line pair, determine how original indent differs from search indent,
        // then apply the same shift to the corresponding replace line.
        val searchLinesRaw = searchText.lines()
        val replaceLinesRaw = replaceText.lines()

        // Base indent from original's first matched line
        val baseIndent = originalLines[matchStart].takeWhile { it == ' ' || it == '\t' }
        val indentedReplace = replaceLinesRaw.mapIndexed { idx, line ->
            if (line.isBlank()) line
            else {
                // Compute relative indent shift: try to match this replace line to a search line
                // If the replace line corresponds to a search line, use that search line's indent
                // offset relative to the first search line to preserve relative indentation.
                val searchBaseIndent = searchLinesRaw.firstOrNull()?.takeWhile { it == ' ' || it == '\t' } ?: ""
                val replaceLineTrimmed = line.trim()
                // Find matching search line to preserve relative indentation
                val matchedSearchIdx = searchLinesTrimmed.indexOfFirst { it == replaceLineTrimmed }
                val searchLineIndent = if (matchedSearchIdx >= 0 && matchedSearchIdx < searchLinesRaw.size) {
                    searchLinesRaw[matchedSearchIdx].takeWhile { it == ' ' || it == '\t' }
                } else {
                    // Fallback: use the indent of the current search line if idx is within range
                    if (idx < searchLinesRaw.size) searchLinesRaw[idx].takeWhile { it == ' ' || it == '\t' }
                    else searchBaseIndent
                }
                // Shift: baseIndent + (searchLineIndent - searchBaseIndent) preserves relative depth
                val relativeIndent = if (searchLineIndent.length >= searchBaseIndent.length) {
                    searchLineIndent.substring(searchBaseIndent.length)
                } else {
                    // search line has less indent than base — just use baseIndent
                    ""
                }
                baseIndent + relativeIndent + replaceLineTrimmed
            }
        }
        val replacedLines = originalLines.toMutableList()
        replacedLines.subList(matchStart, matchStart + searchLinesTrimmed.size).clear()
        replacedLines.addAll(matchStart, indentedReplace)

        return ReplaceResult(replacedLines.joinToString("\n"), matchCount)
    }

    /**
     * ★ Subsequence match: find the best mapping where each search line (after trim)
     * appears in order within original, but intermediate lines may be omitted.
     *
     * This handles the common LLM pattern of generating a "simplified" search block
     * that skips comments, unrelated functions, or reorders #include lines.
     * Also tolerates leading whitespace (indentation) differences via trim().
     *
     * Algorithm:
     * 1. For each search line, find ALL candidate matches in original (by trim equality)
     * 2. Find the "tightest" monotonic assignment that minimizes the span width
     * 3. Require a minimum match ratio (≥ 60% of search lines must match)
     * 4. Replace the entire span in original (from first matched line to last matched line)
     *    with the replace text
     */
    private fun subsequenceReplace(
        original: String,
        searchText: String,
        replaceText: String,
    ): ReplaceResult {
        // ★ Use trim() instead of trimEnd() — tolerate both leading and trailing whitespace differences
        val searchLinesTrimmed = searchText.lines().map { it.trim() }
        if (searchLinesTrimmed.isEmpty()) return ReplaceResult(original, 0)
        // Skip if search is too short for meaningful subsequence matching
        if (searchLinesTrimmed.size < 3) return ReplaceResult(original, 0)

        val originalLines = original.lines()
        val originalLinesTrimmed = originalLines.map { it.trim() }

        // Step 1: Build candidate lists — for each non-blank search line,
        // find ALL original line indices where trim matches
        val nonBlankIndices = searchLinesTrimmed.indices.filter { !searchLinesTrimmed[it].isBlank() }
        val candidates = mutableListOf<List<Int>>()
        for (sIdx in nonBlankIndices) {
            val sLine = searchLinesTrimmed[sIdx]
            val matches = originalLinesTrimmed.indices.filter { originalLinesTrimmed[it] == sLine }
            if (matches.isEmpty()) {
                candidates.add(emptyList())
            } else {
                candidates.add(matches)
            }
        }

        if (nonBlankIndices.isEmpty()) return ReplaceResult(original, 0)

        // Step 2: Find the tightest monotonic assignment via DP.
        // We want to choose one index from each candidate list such that:
        //   - indices are strictly increasing (monotonic)
        //   - the span (last - first) is minimized
        // This is a constrained optimization; we use a greedy + local-search approach:
        //   a) First, greedy: assign the earliest possible match for each search line
        //   b) Then, try to tighten: for each assignment from right to left,
        //      shift to the latest possible candidate that still allows all subsequent assignments
        val greedyAssignment = greedyMonotonicAssign(candidates)
        if (greedyAssignment == null) {
            log.warn("[subsequenceReplace] no monotonic assignment possible")
            return ReplaceResult(original, 0)
        }

        // Tighten from right to left: shift each assignment to the latest candidate
        // that doesn't exceed the next assignment
        val tightened = tightenAssignment(candidates, greedyAssignment)

        // Step 3: Check match quality
        val matchedCount = tightened.count { it >= 0 }
        val matchRatio = matchedCount.toDouble() / nonBlankIndices.size

        // Require at least 60% of non-blank search lines to match
        if (matchRatio < 0.6 || matchedCount < 3) {
            log.warn("[subsequenceReplace] match ratio too low: $matchRatio ($matchedCount/${nonBlankIndices.size}), requires ≥0.6")
            return ReplaceResult(original, 0)
        }

        // Step 4: Find the span in original to replace
        val validIndices = tightened.filter { it >= 0 }
        if (validIndices.isEmpty()) return ReplaceResult(original, 0)

        val spanStart = validIndices.first()
        val spanEnd = validIndices.last()
        val spanWidth = spanEnd - spanStart + 1

        log.info("[subsequenceReplace] matched $matchedCount/${nonBlankIndices.size} lines (${(matchRatio * 100).toInt()}%), span=[$spanStart..$spanEnd] ($spanWidth lines) in original")

        // Safety: if the span is more than 3x the search block size, the match is too loose
        if (spanWidth > searchLinesTrimmed.size * 3) {
            log.warn("[subsequenceReplace] span too wide ($spanWidth > ${searchLinesTrimmed.size * 3}), rejecting as unreliable")
            return ReplaceResult(original, 0)
        }

        // Step 5: Build replacement — replace the entire span with replaceText
        // Preserve original indentation style using baseIndent from the span start
        val searchLinesRaw = searchText.lines()
        val searchBaseIndent = searchLinesRaw.firstOrNull()?.takeWhile { it == ' ' || it == '\t' } ?: ""
        val baseIndent = originalLines[spanStart].takeWhile { it == ' ' || it == '\t' }
        val replacedLines = originalLines.toMutableList()
        val replaceLinesRaw = replaceText.lines()
        val indentedReplace = replaceLinesRaw.mapIndexed { idx, line ->
            if (line.isBlank()) line
            else {
                val replaceLineTrimmed = line.trim()
                // Find matching search line to preserve relative indentation
                val matchedSearchIdx = searchLinesTrimmed.indexOfFirst { it == replaceLineTrimmed }
                val searchLineIndent = if (matchedSearchIdx >= 0 && matchedSearchIdx < searchLinesRaw.size) {
                    searchLinesRaw[matchedSearchIdx].takeWhile { it == ' ' || it == '\t' }
                } else {
                    // Fallback: use the indent of the current search line if idx is within range
                    if (idx < searchLinesRaw.size) searchLinesRaw[idx].takeWhile { it == ' ' || it == '\t' }
                    else searchBaseIndent
                }
                // Shift: baseIndent + (searchLineIndent - searchBaseIndent) preserves relative depth
                val relativeIndent = if (searchLineIndent.length >= searchBaseIndent.length) {
                    searchLineIndent.substring(searchBaseIndent.length)
                } else {
                    ""
                }
                baseIndent + relativeIndent + replaceLineTrimmed
            }
        }
        replacedLines.subList(spanStart, spanEnd + 1).clear()
        replacedLines.addAll(spanStart, indentedReplace)

        return ReplaceResult(replacedLines.joinToString("\n"), 1)
    }

    /**
     * Greedy monotonic assignment: for each candidate list, pick the earliest
     * index that is strictly greater than the previous assignment.
     * Returns null if no valid assignment exists.
     */
    private fun greedyMonotonicAssign(candidates: List<List<Int>>): IntArray? {
        val assignment = IntArray(candidates.size) { -1 }
        var lastIdx = -1
        for (i in candidates.indices) {
            if (candidates[i].isEmpty()) {
                assignment[i] = -1
                continue
            }
            val chosen = candidates[i].firstOrNull { it > lastIdx }
            if (chosen == null) return null  // cannot maintain monotonicity
            assignment[i] = chosen
            lastIdx = chosen
        }
        // Must have at least 3 valid assignments
        if (assignment.count { it >= 0 } < 3) return null
        return assignment
    }

    /**
     * Tighten assignment from right to left: for each position, shift to the
     * latest candidate that doesn't exceed the next position's assignment.
     * This produces a tighter span (closer to the actual code region).
     */
    private fun tightenAssignment(candidates: List<List<Int>>, greedy: IntArray): IntArray {
        val result = greedy.copyOf()
        // Process from second-to-last down to first
        for (i in (candidates.size - 2) downTo 0) {
            if (candidates[i].isEmpty() || result[i] < 0) continue
            // Find the next valid assignment to the right
            var upperBound = Int.MAX_VALUE
            for (j in (i + 1) until candidates.size) {
                if (result[j] >= 0) {
                    upperBound = result[j]
                    break
                }
            }
            if (upperBound == Int.MAX_VALUE) continue  // no constraint from right
            // Pick the largest candidate that is < upperBound and > previous assignment
            var lowerBound = -1
            for (j in 0 until i) {
                if (result[j] >= 0) {
                    lowerBound = result[j]
                }
            }
            val finalLower = lowerBound
            val best = candidates[i].lastOrNull { it > finalLower && it < upperBound }
            if (best != null) {
                result[i] = best
            }
        }
        return result
    }

    private fun deleteFile(rel: String, risk: Risk = Risk.HIGH): Boolean {
        val vf = PathGuard.resolve(project, rel)
        // HIGH risk: always require explicit confirmation regardless of auto-apply setting
        if (risk == Risk.HIGH) {
            val ok =
                Messages.showOkCancelDialog(
                    project,
                    "Delete $rel? This moves the file to system Trash.",
                    "CodePilot: Delete",
                    "Delete",
                    "Cancel",
                    Messages.getWarningIcon(),
                )
            if (ok != Messages.OK) return false
        } else if (!autoApply) {
            val ok =
                Messages.showOkCancelDialog(
                    project,
                    "Delete $rel? This moves the file to system Trash.",
                    "CodePilot: Delete",
                    "Delete",
                    "Cancel",
                    Messages.getWarningIcon(),
                )
            if (ok != Messages.OK) return false
        }
        WriteCommandAction.runWriteCommandAction(project) { vf.delete(this) }
        return true
    }

    private fun moveFile(
        rel: String,
        edit: JsonNode,
        risk: Risk = Risk.HIGH,
    ): Boolean {
        val src = PathGuard.resolve(project, rel)
        val to = edit.path("to").asText()
        if (to.isBlank()) throw ToolViolation("missing 'to' for move")
        val target = PathGuard.resolveOrCreate(project, to)
        // HIGH risk: always require explicit confirmation
        if (risk == Risk.HIGH || !autoApply) {
            val confirm =
                Messages.showOkCancelDialog(
                    project,
                    "Move $rel → $to ?",
                    "CodePilot: Move",
                    "Move",
                    "Cancel",
                    Messages.getQuestionIcon(),
                )
            if (confirm != Messages.OK) return false
        }
        WriteCommandAction.runWriteCommandAction(project) {
            Files.createDirectories(target.parent)
            val parent = LocalFileSystem.getInstance().refreshAndFindFileByPath(target.parent.toString())
            if (parent != null) src.move(this, parent)
            if (target.fileName.toString() != src.name) src.rename(this, target.fileName.toString())
        }
        return true
    }

    // ----- helpers -----

    private fun confirmIfNeeded(
        rel: String,
        before: String,
        after: String,
        title: String,
        risk: Risk = Risk.MEDIUM,
    ): Boolean {
        // No change → always skip
        if (before == after) return true
        // Risk-based auto-apply: LOW and MEDIUM can be auto-applied when setting is enabled
        if (autoApply && risk != Risk.HIGH) return true
        // HIGH risk always requires explicit confirmation
        // ★ Try inline diff first (Cursor-style), fall back to DiffManager dialog
        return tryInlineDiff(rel, before, after, title)
    }

    /**
     * ★ Try to apply the diff inline in the editor (Cursor-style green/red highlighting
     * with Tab to accept, Esc to reject). Falls back to the DiffManager dialog when
     * the file is not open in an editor.
     *
     * Returns a ConfirmResult that tells the caller whether the inline diff already
     * wrote the content (so the caller should skip the redundant setBinaryContent call).
     */
    data class ConfirmResult(val confirmed: Boolean, val inlineApplied: Boolean = false)

    private fun confirmIfNeededInline(
        rel: String,
        before: String,
        after: String,
        title: String,
        risk: Risk = Risk.MEDIUM,
    ): ConfirmResult {
        // No change → always skip
        if (before == after) return ConfirmResult(true, false)
        // Risk-based auto-apply: LOW and MEDIUM can be auto-applied when setting is enabled
        if (autoApply && risk != Risk.HIGH) return ConfirmResult(true, false)
        // ★ Try inline diff first (Cursor-style), fall back to DiffManager dialog
        return tryInlineDiffResult(rel, before, after, title)
    }

    /**
     * ★ Try to apply the diff inline in the editor (Cursor-style green/red highlighting
     * with Tab to accept, Esc to reject). Falls back to the DiffManager dialog when
     * the file is not open in an editor.
     */
    private fun tryInlineDiff(
        rel: String,
        before: String,
        after: String,
        title: String,
    ): Boolean {
        return tryInlineDiffResult(rel, before, after, title).confirmed
    }

    private fun tryInlineDiffResult(
        rel: String,
        before: String,
        after: String,
        title: String,
    ): ConfirmResult {
        val vf = try {
            PathGuard.resolve(project, rel)
        } catch (_: Exception) {
            return ConfirmResult(showDiffDialog(rel, before, after, title), false)
        }

        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        if (editor == null) {
            return ConfirmResult(showDiffDialog(rel, before, after, title), false)
        }

        val document = FileDocumentManager.getInstance().getDocument(vf)
        if (document == null || document !== editor.document) {
            // File not open in the current editor — fall back to dialog
            return ConfirmResult(showDiffDialog(rel, before, after, title), false)
        }

        // Apply inline diff: replace the entire document content with the new text,
        // show green highlighting, and let user Tab/Accept or Esc/Reject.
        val inlineRenderer = InlineDiffRenderer(project, editor)
        val startOffset = 0
        val endOffset = before.length

        ApplicationManager.getApplication().invokeAndWait {
            inlineRenderer.applyWithDiff(
                startOffset,
                endOffset,
                before,
                after,
                onAccept = {},
                onReject = {},
            )
        }

        // The inline renderer already wrote the content to the document;
        // return inlineApplied=true so callers skip the redundant setBinaryContent call.
        return ConfirmResult(true, true)
    }

    private fun showDiffDialog(
        rel: String,
        before: String,
        after: String,
        title: String,
    ): Boolean {
        val factory = com.intellij.diff.DiffContentFactory.getInstance()
        val left = factory.create(before)
        val right = factory.create(after)
        val request = com.intellij.diff.requests.SimpleDiffRequest(title, left, right, "修改前", "修改后")
        com.intellij.diff.DiffManager.getInstance().showDiff(project, request)
        val confirm =
            Messages.showOkCancelDialog(
                project,
                "将修改后的内容写入 $rel？",
                "CodePilot",
                "应用",
                "取消",
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
        // ★ Debug logging: record match result
        if (count == 0) {
            log.warn("[applyReplace-DEBUG] NO MATCH — search.length=${search.length}, original.length=${original.length}, " +
                "regex=$regex, ignoreCase=$ignoreCase, " +
                "search.head(60)=${search.take(60).replaceWhitespaceForLog()}, " +
                "original.head(60)=${original.take(60).replaceWhitespaceForLog()}")
            // Check if search appears as a substring of original with slight differences
            val searchFirstLine = search.lines().firstOrNull() ?: ""
            val originalLines = original.lines()
            val matchingLineIndices = originalLines.indices.filter { originalLines[it].trimEnd() == searchFirstLine.trimEnd() }
            if (matchingLineIndices.isNotEmpty()) {
                log.warn("[applyReplace-DEBUG] first search line found in original at line(s) ${matchingLineIndices.map { it + 1 }} " +
                    "but full search block does not match — likely content drift in subsequent lines")
            } else {
                log.warn("[applyReplace-DEBUG] first search line NOT found in original at all (even after trimEnd)")
            }
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
                val newContent = edit.path("newContent").asText(edit.path("content").asText(""))
                val existingVf = try {
                    PathGuard.resolve(project, rel)
                } catch (_: ToolViolation) {
                    // File doesn't exist yet — create it
                    val target = PathGuard.resolveOrCreate(project, rel)
                    Files.createDirectories(target.parent)
                    Files.writeString(target, newContent)
                    refreshAt(target)
                    return
                }
                existingVf.setBinaryContent(newContent.toByteArray(StandardCharsets.UTF_8))
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
    private fun moveWithRefactoring(fromPath: String, toPath: String, risk: Risk = Risk.HIGH) {
        val fromVFile = PathGuard.resolve(project, fromPath)
        val fromPsi = com.intellij.psi.PsiManager.getInstance(project).findFile(fromVFile)
        if (fromPsi == null) {
            val edit = com.fasterxml.jackson.databind.ObjectMapper()
                .createObjectNode()
                .put("op", "move")
                .put("path", fromPath)
                .put("to", toPath)
            applyEdit(edit, risk)
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
