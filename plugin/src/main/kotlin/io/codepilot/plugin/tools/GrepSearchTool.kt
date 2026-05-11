package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicInteger

/**
 * Regex-based full-text search across the project workspace (read-only).
 * Returns matched lines with surrounding context, similar to ripgrep output.
 *
 * Used by Gather nodes (kind=fs.grep). Unlike the basic fs.search in
 * ToolDispatcher, this returns structured hit objects with context lines.
 */
class GrepSearchTool(
    private val project: Project,
) {
    fun grep(args: JsonNode): Map<String, Any?> {
        val pattern = args.path("pattern").asText("")
        if (pattern.isBlank()) throw ToolViolation("empty grep pattern")
        val isRegex = args.path("regex").asBoolean(true)
        val contextLines = args.path("contextLines").asInt(2).coerceIn(0, 5)
        val maxHits = args.path("maxHits").asInt(50).coerceAtMost(200)
        val fileGlob = args.path("fileGlob").asText("") // e.g. "*.java"

        val regex = if (isRegex) Regex(pattern) else Regex(Regex.escape(pattern))
        val root = PathGuard.projectRoot(project)
        val hits = mutableListOf<Map<String, Any?>>()
        val hitCount = AtomicInteger(0)

        VfsUtil.processFilesRecursively(root) { vf ->
            if (hitCount.get() >= maxHits) return@processFilesRecursively false
            if (vf.isDirectory || vf.length > 1_048_576) return@processFilesRecursively true
            if (fileGlob.isNotEmpty() && !matchGlob(vf.name, fileGlob)) return@processFilesRecursively true

            val text =
                runCatching { String(vf.contentsToByteArray(), StandardCharsets.UTF_8) }
                    .getOrNull() ?: return@processFilesRecursively true
            val lines = text.lines()
            for ((idx, line) in lines.withIndex()) {
                if (hitCount.get() >= maxHits) break
                if (regex.containsMatchIn(line)) {
                    hitCount.incrementAndGet()
                    val from = (idx - contextLines).coerceAtLeast(0)
                    val to = (idx + contextLines + 1).coerceAtMost(lines.size)
                    hits.add(
                        mapOf(
                            "path" to vf.path.removePrefix(root.path).trimStart('/'),
                            "line" to (idx + 1),
                            "matchLine" to line.take(200),
                            "context" to lines.subList(from, to).joinToString("\n"),
                        ),
                    )
                }
            }
            true
        }

        return mapOf("pattern" to pattern, "totalHits" to hits.size, "hits" to hits)
    }

    private fun matchGlob(
        fileName: String,
        glob: String,
    ): Boolean {
        // Simple glob: *.java → endsWith(.java)
        if (glob.startsWith("*.")) return fileName.endsWith(glob.removePrefix("*"))
        return fileName == glob
    }
}
