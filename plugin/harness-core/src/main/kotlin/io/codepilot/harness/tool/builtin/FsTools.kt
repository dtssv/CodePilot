package io.codepilot.harness.tool.builtin

import io.codepilot.harness.model.ToolSchema
import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import io.codepilot.harness.tool.WorkspaceScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.io.path.writeText
import kotlin.streams.toList

private val json = Json { ignoreUnknownKeys = true }

private fun str(args: JsonObject, key: String): String =
    args[key]?.jsonPrimitive?.content ?: throw IllegalArgumentException("missing arg: $key")

abstract class FsTool : Tool {
    protected lateinit var scope: WorkspaceScope
    fun bind(scope: WorkspaceScope) {
        this.scope = scope
    }

    protected fun inScope(pathArg: String): Path =
        scope.resolve(pathArg) ?: throw SecurityException("path escapes workspace: $pathArg")
}

private const val MAX_READ_BYTES = 32_768

class ReadFileTool(scope: WorkspaceScope) : FsTool() {
    init { bind(scope) }
    override val spec = ToolSpec(
        name = "read_file",
        description = "Read a text file inside the workspace. Long files are truncated.",
        parametersJson = """{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}""",
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val path = inScope(str(args, "path"))
        if (!path.isRegularFile()) return ToolOutput.failure("not a file: ${path.fileName}")
        val bytes = Files.readAllBytes(path)
        val truncatedFlag = bytes.size > MAX_READ_BYTES
        val content = if (truncatedFlag) String(bytes.copyOf(MAX_READ_BYTES), Charsets.UTF_8) + "\n...[truncated]" else String(bytes, Charsets.UTF_8)
        ToolOutput.success(content, truncatedFlag)
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }
}

class WriteFileTool(scope: WorkspaceScope) : FsTool() {
    init { bind(scope) }
    override val spec = ToolSpec(
        name = "write_file",
        description = "Write full content to a file inside the workspace (overwrites).",
        dangerLevel = DangerLevel.WRITE,
        parametersJson = """{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}""",
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val path = inScope(str(args, "path"))
        path.parent?.let { Files.createDirectories(it) }
        Files.writeString(path, str(args, "content"))
        ToolOutput.success("written ${path.fileName}")
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }
}

class EditFileTool(scope: WorkspaceScope) : FsTool() {
    init { bind(scope) }
    override val spec = ToolSpec(
        name = "edit_file",
        description = "Replace an exact substring occurrence in a file. Fails if old_string not found or not unique unless replace_all.",
        dangerLevel = DangerLevel.WRITE,
        parametersJson = """{"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["path","old_string","new_string"]}""",
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val path = inScope(str(args, "path"))
        val oldS = str(args, "old_string")
        val newS = str(args, "new_string")
        val replaceAll = args["replace_all"]?.jsonPrimitive?.content?.toBoolean() ?: false
        if (!path.isRegularFile()) return ToolOutput.failure("not a file: ${path.fileName}")
        val content = path.readText()
        val occurrences = countOccurrences(content, oldS)
        if (occurrences == 0) return ToolOutput.failure("old_string not found")
        if (occurrences > 1 && !replaceAll) return ToolOutput.failure("old_string matches $occurrences times; pass replace_all=true")
        val updated = if (replaceAll) content.replace(oldS, newS) else content.replaceFirst(oldS, newS)
        path.writeText(updated)
        ToolOutput.success("edited ${path.fileName} ($occurrences -> applied)")
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }

    private fun countOccurrences(haystack: String, needle: String): Int {
        var count = 0
        var idx = 0
        while (needle.isNotEmpty()) {
            idx = haystack.indexOf(needle, idx)
            if (idx < 0) break
            count++
            idx += needle.length
        }
        return count
    }
}

class ListDirTool(scope: WorkspaceScope) : FsTool() {
    init { bind(scope) }
    override val spec = ToolSpec(
        name = "list_dir",
        description = "List directory entries (non-recursive).",
        parametersJson = """{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}""",
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val path = inScope(str(args, "path").ifEmpty { "." })
        val entries = Files.list(path).use { s -> s.toList().map { if (Files.isDirectory(it)) it.fileName.toString() + "/" else it.fileName.toString() } }
        ToolOutput.success(entries.sorted().joinToString("\n"))
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }
}

data class GrepHit(val relPath: String, val lineNo: Int, val line: String)

class GrepTool(private val scope: WorkspaceScope) : Tool {
    override val spec = ToolSpec(
        name = "grep",
        description = "Regex search across workspace text files. Returns path:line:line-content hits (capped).",
        parametersJson = """{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]}""",
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val pattern = Regex(str(args, "pattern"))
        val hits = mutableListOf<GrepHit>()
        val rootPath: Path = scope.root
        Files.walk(rootPath).use { stream ->
            stream.filter { it.isRegularFile() && !isBinaryPath(it) }.toList().forEach { f ->
                if (hits.size < MAX_HITS) {
                    runCatching {
                        f.readText().lineSequence().forEachIndexed { i, line ->
                            if (hits.size < MAX_HITS && pattern.containsMatchIn(line)) {
                                hits.add(GrepHit(rootPath.relativize(f).toString(), i + 1, line.take(300)))
                            }
                        }
                    }
                }
            }
        }
        if (hits.isEmpty()) ToolOutput.success("no matches")
        else ToolOutput.success(hits.joinToString("\n") { "${it.relPath}:${it.lineNo}:${it.line}" }, truncated = hits.size >= MAX_HITS)
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }

    private fun isBinaryPath(p: Path): Boolean =
        p.fileName.toString().matches(Regex(".*\\.(jar|class|png|jpg|gif|zip|tar|gz|bin|so|dylib|pdf)$"))

    companion object {
        const val MAX_HITS = 100
    }
}

fun defaultFsCatalog(scope: WorkspaceScope): List<Tool> = listOf(
    ReadFileTool(scope),
    WriteFileTool(scope),
    EditFileTool(scope),
    ListDirTool(scope),
    GrepTool(scope),
)

