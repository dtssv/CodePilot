package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.project.Project
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Enhanced read-only file reader for Gather nodes.
 * Returns sha1, totalLines, range-sliced content, and truncation info —
 * everything the Graph Orchestrator needs for cache invalidation and
 * context budget control.
 */
class FileReader(private val project: Project) {

    fun read(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val maxBytes = args.path("maxBytes").asInt(262_144).coerceAtMost(1_048_576)
        val vf = PathGuard.resolve(project, path)
        val raw = vf.contentsToByteArray()
        if (raw.size > maxBytes) {
            throw ToolViolation("file too large: ${raw.size} > $maxBytes")
        }
        val text = String(raw, StandardCharsets.UTF_8)
        val allLines = text.lines()
        val totalLines = allLines.size
        val sha1 = sha1Hex(raw)

        // Support single range or multiple ranges
        val rangeNode = args.path("range")
        val content: String
        val truncated: Boolean
        if (rangeNode.isArray && rangeNode.size() == 2) {
            val start = rangeNode[0].asInt(1)
            val end = rangeNode[1].asInt(totalLines)
            content = sliceLines(allLines, start, end)
            truncated = start > 1 || end < totalLines
        } else {
            content = text
            truncated = false
        }

        return mapOf(
            "path" to vf.path.removePrefix(PathGuard.projectRoot(project).path).trimStart('/'),
            "sha1" to sha1,
            "totalLines" to totalLines,
            "bytes" to raw.size,
            "truncated" to truncated,
            "lang" to vf.fileType.name,
            "content" to content,
        )
    }

    private fun sliceLines(lines: List<String>, start: Int, end: Int): String {
        val from = (start - 1).coerceIn(0, lines.size)
        val to = end.coerceIn(from, lines.size)
        return lines.subList(from, to).joinToString("\n")
    }

    companion object {
        fun sha1Hex(data: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-1")
            return digest.digest(data).joinToString("") { "%02x".format(it) }
        }
    }
}