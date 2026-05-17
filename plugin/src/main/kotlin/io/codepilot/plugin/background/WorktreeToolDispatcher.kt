package io.codepilot.plugin.background

import com.fasterxml.jackson.databind.JsonNode
import io.codepilot.plugin.conversation.ConversationClient
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.isDirectory

class WorktreeToolDispatcher(
    private val worktree: Path,
    private val client: ConversationClient,
    private val sessionId: String,
    private val log: (String) -> Unit,
) {
    fun dispatch(toolCall: JsonNode) {
        val id = toolCall.path("id").asText()
        val name = toolCall.path("name").asText()
        val args = toolCall.path("args")
        Thread({
            val result = runCatching {
                when (name) {
                    "fs.read" -> read(args)
                    "fs.list" -> list(args)
                    "fs.create", "fs.write" -> write(args, allowCreate = true)
                    "fs.replace" -> write(args, allowCreate = false)
                    "fs.delete" -> delete(args)
                    "shell.exec" -> shell(args)
                    else -> error("unsupported background tool: $name")
                }
            }
            result.fold(
                onSuccess = {
                    log("tool_result ok $name $id")
                    client.submitToolResult(sessionId, id, it, true)
                },
                onFailure = {
                    log("tool_result error $name $id ${it.message}")
                    client.submitToolResult(sessionId, id, mapOf("error" to (it.message ?: "tool failed")), false)
                },
            )
        }, "codepilot-bg-tool-$id").apply { isDaemon = true; start() }
    }

    private fun read(args: JsonNode): Map<String, Any?> {
        val path = resolve(args.path("path").asText())
        return mapOf("path" to worktree.relativize(path).toString(), "content" to Files.readString(path))
    }

    private fun list(args: JsonNode): Map<String, Any?> {
        val dir = resolve(args.path("path").asText("."))
        if (!dir.isDirectory()) error("not a directory: $dir")
        val entries = Files.list(dir).use { stream ->
            stream.limit(args.path("limit").asLong(200)).map {
                mapOf("name" to it.fileName.toString(), "path" to worktree.relativize(it).toString(), "isDirectory" to Files.isDirectory(it))
            }.toList()
        }
        return mapOf("path" to worktree.relativize(dir).toString(), "entries" to entries)
    }

    private fun write(args: JsonNode, allowCreate: Boolean): Map<String, Any?> {
        val path = resolve(args.path("path").asText())
        if (!allowCreate && !path.exists()) error("file does not exist: $path")
        Files.createDirectories(path.parent)
        val content = args.path("content").asText(args.path("newContent").asText(""))
        Files.writeString(path, content)
        return mapOf("path" to worktree.relativize(path).toString(), "bytes" to content.toByteArray().size)
    }

    private fun delete(args: JsonNode): Map<String, Any?> {
        val path = resolve(args.path("path").asText())
        Files.deleteIfExists(path)
        return mapOf("path" to worktree.relativize(path).toString(), "deleted" to true)
    }

    private fun shell(args: JsonNode): Map<String, Any?> {
        val command = args.path("command").asText().ifBlank { error("empty command") }
        val os = System.getProperty("os.name").lowercase()
        val argv = if (os.contains("win")) listOf("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
        else listOf("/bin/bash", "-lc", command)
        val started = System.currentTimeMillis()
        val proc = ProcessBuilder(argv).directory(worktree.toFile()).redirectErrorStream(true).start()
        val out = proc.inputStream.bufferedReader().readText()
        val code = proc.waitFor()
        return mapOf("command" to command, "exitCode" to code, "stdout" to out, "durationMs" to (System.currentTimeMillis() - started))
    }

    private fun resolve(raw: String): Path {
        val p = worktree.resolve(raw.ifBlank { "." }).normalize()
        if (!p.startsWith(worktree)) error("path escapes worktree: $raw")
        return p
    }
}
