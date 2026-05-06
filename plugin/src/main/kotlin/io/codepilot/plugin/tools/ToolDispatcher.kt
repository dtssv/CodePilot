package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import io.codepilot.plugin.conversation.ConversationClient
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicLong

/**
 * Routes a model-issued `tool_call` to a real client-side handler. Currently supports the safe
 * read tools and `fs.create`. Mutating ops (write/replace/move/delete) go through [PatchApplier]
 * via Diff approval — they are NOT executed silently here.
 */
class ToolDispatcher(
    private val project: Project,
    private val client: ConversationClient,
    private val sessionId: String,
) {

    fun dispatch(toolCall: JsonNode) {
        val name = toolCall.path("name").asText()
        val id = toolCall.path("id").asText()
        val args = toolCall.path("args")
        ApplicationManager.getApplication().executeOnPooledThread {
            val started = System.nanoTime()
            try {
                val result = when (name) {
                    "fs.read" -> readFile(args)
                    "fs.list" -> listDir(args)
                    "fs.search" -> searchProject(args)
                    "fs.outline" -> fileOutline(args)
                    "fs.create" -> createFile(args)
                    "shell.exec" -> ShellExecutor(project).execute(args)
                    "plan.show" -> mapOf("ack" to true)
                    else -> return@executeOnPooledThread refuse(id, "unsupported tool: $name", started)
                }
                respond(id, true, result, null, null, started)
            } catch (v: ToolViolation) {
                respond(id, false, null, "path_violation", v.message, started)
            } catch (t: Throwable) {
                respond(id, false, null, "tool_error", t.message ?: t.javaClass.simpleName, started)
            }
        }
    }

    private fun refuse(toolCallId: String, reason: String, startedNs: Long) {
        respond(toolCallId, false, null, "unsupported", reason, startedNs)
    }

    private fun respond(
        toolCallId: String,
        ok: Boolean,
        result: Any?,
        errorCode: String?,
        errorMessage: String?,
        startedNs: Long,
    ) {
        val durationMs = (System.nanoTime() - startedNs) / 1_000_000
        client.submitToolResult(
            mutableMapOf<String, Any?>(
                "sessionId" to sessionId,
                "toolCallId" to toolCallId,
                "ok" to ok,
                "result" to result,
                "errorCode" to errorCode,
                "errorMessage" to errorMessage,
                "durationMs" to durationMs,
            ),
        )
    }

    // ---------- read tools ----------

    private fun readFile(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val maxBytes = args.path("maxBytes").asInt(262_144).coerceAtMost(1_048_576)
        val vf = PathGuard.resolve(project, path)
        if (vf.length > maxBytes) {
            throw ToolViolation("file too large: ${vf.length} > $maxBytes")
        }
        val text = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
        val (start, end) = readRange(args)
        val sliced = if (start != null && end != null) sliceLines(text, start, end) else text
        return mapOf(
            "path" to vf.path,
            "lang" to (vf.fileType.name),
            "size" to vf.length,
            "content" to sliced,
        )
    }

    private fun readRange(args: JsonNode): Pair<Int?, Int?> {
        val s = args.path("range").path("startLine").asInt(0).takeIf { it > 0 }
        val e = args.path("range").path("endLine").asInt(0).takeIf { it > 0 }
        return s to e
    }

    private fun sliceLines(text: String, start: Int, end: Int): String {
        val lines = text.lines()
        val from = (start - 1).coerceIn(0, lines.size)
        val to = end.coerceIn(from, lines.size)
        return lines.subList(from, to).joinToString("\n")
    }

    private fun listDir(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val recursive = args.path("recursive").asBoolean(false)
        val vf = PathGuard.resolve(project, path)
        if (!vf.isDirectory) throw ToolViolation("not a directory: $path")
        val entries = mutableListOf<Map<String, Any?>>()
        VfsUtil.processFilesRecursively(vf) { f ->
            if (f != vf) {
                entries.add(
                    mapOf(
                        "path" to f.path.removePrefix(PathGuard.projectRoot(project).path).trimStart('/'),
                        "type" to if (f.isDirectory) "dir" else "file",
                        "size" to f.length,
                    ),
                )
            }
            recursive || f.parent == vf
        }
        return mapOf("entries" to entries.take(2_000))
    }

    private fun searchProject(args: JsonNode): Map<String, Any?> {
        val query = args.path("query").asText()
        if (query.isBlank()) throw ToolViolation("empty query")
        val regex = args.path("regex").asBoolean(false)
        val pattern = if (regex) Regex(query) else Regex(Regex.escape(query))
        val hits = mutableListOf<Map<String, Any?>>()
        val root = PathGuard.projectRoot(project)
        val limit = AtomicLong(50)
        VfsUtil.processFilesRecursively(root) { f ->
            if (limit.get() <= 0) return@processFilesRecursively false
            if (!f.isDirectory && f.length < 1_048_576) {
                val text = runCatching { String(f.contentsToByteArray(), StandardCharsets.UTF_8) }
                    .getOrNull() ?: return@processFilesRecursively true
                pattern.findAll(text).take(5).forEach { m ->
                    if (limit.decrementAndGet() < 0) return@forEach
                    val before = text.substring(0, m.range.first).count { it == '\n' } + 1
                    hits.add(
                        mapOf(
                            "path" to f.path.removePrefix(root.path).trimStart('/'),
                            "line" to before,
                            "snippet" to m.value.take(120),
                        ),
                    )
                }
            }
            true
        }
        return mapOf("hits" to hits)
    }

    private fun fileOutline(args: JsonNode): Map<String, Any?> {
        val vf = PathGuard.resolve(project, args.path("path").asText())
        // Lightweight outline: line count + first non-empty line preview. Real PSI outline can be
        // added once a language-aware analyzer is plugged in.
        val text = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
        val firstLine = text.lineSequence().firstOrNull { it.isNotBlank() }
        return mapOf(
            "path" to vf.path,
            "lines" to text.count { it == '\n' } + 1,
            "firstNonEmptyLine" to (firstLine ?: ""),
        )
    }

    // ---------- mutating: fs.create only (others go through PatchApplier) ----------

    private fun createFile(args: JsonNode): Map<String, Any?> {
        val rel = args.path("path").asText()
        val content = args.path("content").asText("")
        val overwrite = args.path("overwrite").asBoolean(false)
        val target = PathGuard.resolveOrCreate(project, rel)
        if (Files.exists(target) && !overwrite) {
            throw ToolViolation("already exists: $rel (set overwrite=true to replace)")
        }
        WriteCommandAction.runWriteCommandAction(project) {
            Files.createDirectories(target.parent)
            Files.writeString(target, content)
            PathGuard.projectRoot(project).refresh(false, true)
        }
        return mapOf("path" to target.toString(), "bytes" to (content.toByteArray().size))
    }
}