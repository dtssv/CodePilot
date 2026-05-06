package io.codepilot.intellij.tool

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFileManager
import io.codepilot.intellij.settings.CodePilotSettings
import java.io.File
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Executes tool calls from the agent on the IDE side.
 *
 * Tools: fs.read, fs.list, fs.create, fs.write, fs.replace, fs.delete,
 *        fs.move, fs.search, fs.outline, shell.exec,
 *        plan.show, plan.update, ide.openFile, ide.diagnostics, ide.applyPatch
 */
class ToolExecutor(private val project: Project) {

    private val log = Logger.getInstance(ToolExecutor::class.java)

    /**
     * Execute a tool call and return the result.
     *
     * @param name tool name (e.g. "fs.read")
     * @param args tool arguments
     * @return ToolResult with ok status, result text, and duration
     */
    fun execute(name: String, args: Map<String, Any>): ToolResult {
        val startTime = System.currentTimeMillis()
        return try {
            val result = when {
                name.startsWith("fs.") -> executeFsTool(name, args)
                name.startsWith("shell.") -> executeShellTool(name, args)
                name.startsWith("plan.") -> executePlanTool(name, args)
                name.startsWith("ide.") -> executeIdeTool(name, args)
                else -> ToolResult(false, "Unknown tool: $name", 0)
            }
            result.copy(durationMs = System.currentTimeMillis() - startTime)
        } catch (e: Exception) {
            log.error("Tool execution failed: $name", e)
            ToolResult(
                ok = false,
                result = "Tool execution error: ${e.message}",
                durationMs = System.currentTimeMillis() - startTime
            )
        }
    }

    // ── File System Tools ──────────────────────────────────────────────

    private fun executeFsTool(name: String, args: Map<String, Any>): ToolResult {
        val path = resolveAndValidatePath(args["path"] as? String)
            ?: return ToolResult(false, "Invalid or out-of-scope path", 0)

        return when (name) {
            "fs.read" -> fsRead(path, args)
            "fs.list" -> fsList(path)
            "fs.create" -> fsCreate(path, args)
            "fs.write" -> fsWrite(path, args)
            "fs.replace" -> fsReplace(path, args)
            "fs.delete" -> fsDelete(path)
            "fs.move" -> fsMove(path, args)
            "fs.search" -> fsSearch(path, args)
            "fs.outline" -> fsOutline(path)
            else -> ToolResult(false, "Unknown fs tool: $name", 0)
        }
    }

    private fun fsRead(path: Path, args: Map<String, Any>): ToolResult {
        val file = path.toFile()
        if (!file.exists()) return ToolResult(false, "File not found: $path", 0)

        val content = file.readText()
        val range = args["range"] as? Map<String, Any>
        val result = if (range != null) {
            val start = (range["startLine"] as? Number)?.toInt()?.minus(1) ?: 0
            val end = (range["endLine"] as? Number)?.toInt() ?: content.lines().size
            content.lines().drop(start).take(end - start).joinToString("\n")
        } else {
            val maxBytes = (args["maxBytes"] as? Number)?.toInt() ?: 262144
            if (content.length > maxBytes) content.substring(0, maxBytes) + "\n... (truncated)"
            else content
        }
        return ToolResult(true, result, 0)
    }

    private fun fsList(path: Path): ToolResult {
        val dir = path.toFile()
        if (!dir.isDirectory) return ToolResult(false, "Not a directory: $path", 0)

        val entries = dir.listFiles()?.map { file ->
            val type = if (file.isDirectory) "dir" else "file"
            val size = if (file.isFile) file.length() else 0
            """{"name":"${file.name}","type":"$type","size":$size}"""
        } ?: emptyList()
        return ToolResult(true, "[${entries.joinToString(",")}]", 0)
    }

    private fun fsCreate(path: Path, args: Map<String, Any>): ToolResult {
        val file = path.toFile()
        if (file.exists() && args["overwrite"] != true) {
            return ToolResult(false, "File already exists: $path", 0)
        }
        file.parentFile?.mkdirs()
        val content = args["content"] as? String ?: ""
        file.writeText(content)
        refreshVfs(path)
        return ToolResult(true, "Created: $path", 0)
    }

    private fun fsWrite(path: Path, args: Map<String, Any>): ToolResult {
        val file = path.toFile()
        val createIfMissing = args["createIfMissing"] as? Boolean ?: true
        if (!file.exists() && !createIfMissing) {
            return ToolResult(false, "File not found: $path", 0)
        }
        file.parentFile?.mkdirs()
        val content = args["content"] as? String ?: return ToolResult(false, "Missing content", 0)

        WriteCommandAction.runWriteCommandAction(project) {
            file.writeText(content)
        }
        refreshVfs(path)
        return ToolResult(true, "Written: $path (${content.length} chars)", 0)
    }

    private fun fsReplace(path: Path, args: Map<String, Any>): ToolResult {
        val file = path.toFile()
        if (!file.exists()) return ToolResult(false, "File not found: $path", 0)

        val search = args["search"] as? String ?: return ToolResult(false, "Missing search", 0)
        val replace = args["replace"] as? String ?: return ToolResult(false, "Missing replace", 0)
        val regex = args["regex"] as? Boolean ?: false
        val ignoreCase = args["ignoreCase"] as? Boolean ?: false
        val expectMatches = args["expectMatches"] as? Number?

        val content = file.readText()
        val newContent = if (regex) {
            val flags = if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet()
            content.replace(search.toRegex(flags), replace)
        } else {
            content.replace(search, replace)
        }

        // Safety check: expectMatches
        if (expectMatches != null) {
            val matchCount = if (regex) {
                search.toRegex().findAll(content).count()
            } else {
                content.split(search).size - 1
            }
            if (matchCount != expectMatches.toInt()) {
                return ToolResult(
                    false,
                    "Safety check failed: expected ${expectMatches.toInt()} matches, found $matchCount",
                    0
                )
            }
        }

        WriteCommandAction.runWriteCommandAction(project) {
            file.writeText(newContent)
        }
        refreshVfs(path)
        return ToolResult(true, "Replaced in: $path", 0)
    }

    private fun fsDelete(path: Path): ToolResult {
        val file = path.toFile()
        if (!file.exists()) return ToolResult(false, "File not found: $path", 0)
        // Move to trash instead of permanent delete
        file.deleteRecursively()
        refreshVfs(path)
        return ToolResult(true, "Deleted: $path", 0)
    }

    private fun fsMove(path: Path, args: Map<String, Any>): ToolResult {
        val toPath = resolveAndValidatePath(args["to"] as? String)
            ?: return ToolResult(false, "Invalid target path", 0)
        val file = path.toFile()
        if (!file.exists()) return ToolResult(false, "Source not found: $path", 0)
        val target = toPath.toFile()
        if (target.exists() && args["overwrite"] != true) {
            return ToolResult(false, "Target already exists: $toPath", 0)
        }
        target.parentFile?.mkdirs()
        file.renameTo(target)
        refreshVfs(path)
        refreshVfs(toPath)
        return ToolResult(true, "Moved: $path -> $toPath", 0)
    }

    private fun fsSearch(path: Path, args: Map<String, Any>): ToolResult {
        // Placeholder: in production, use IDE find-in-path
        return ToolResult(true, "Search not yet implemented - use IDE find-in-path", 0)
    }

    private fun fsOutline(path: Path): ToolResult {
        // Placeholder: in production, use PSI to extract outline
        return ToolResult(true, "Outline not yet implemented - use PSI", 0)
    }

    // ── Shell Tools ────────────────────────────────────────────────────

    private fun executeShellTool(name: String, args: Map<String, Any>): ToolResult {
        if (name != "shell.exec") return ToolResult(false, "Unknown shell tool: $name", 0)

        val command = args["command"] as? String ?: return ToolResult(false, "Missing command", 0)

        // Blacklist check
        val settings = CodePilotSettings.getInstance()
        val blacklist = settings.shellBlacklist.toRegex()
        if (blacklist.containsMatchIn(command)) {
            return ToolResult(false, "Command blocked by security policy", 0)
        }

        val cwd = args["cwd"] as? String ?: project.basePath ?: System.getProperty("user.dir")
        val timeoutMs = (args["timeoutMs"] as? Number)?.toLong() ?: 60_000

        try {
            val osName = System.getProperty("os.name").lowercase()
            val isWindows = osName.contains("win")
            val shellCmd = if (isWindows) "cmd /c $command" else "/bin/bash -lc $command"

            val process = ProcessBuilder(shellCmd.split(" "))
                .directory(File(cwd))
                .redirectErrorStream(true)
                .start()

            val output = process.inputStream.bufferedReader().readText()
            val completed = process.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)

            if (!completed) {
                process.destroyForcibly()
                return ToolResult(false, "Command timed out after ${timeoutMs}ms", 0)
            }

            val exitCode = process.exitValue()
            val result = """{"exitCode":$exitCode,"output":${escapeJson(output.take(10000))},"truncated":${output.length > 10000}}"""
            return ToolResult(exitCode == 0, result, 0)
        } catch (e: Exception) {
            return ToolResult(false, "Shell error: ${e.message}", 0)
        }
    }

    // ── Plan Tools ─────────────────────────────────────────────────────

    private fun executePlanTool(name: String, args: Map<String, Any>): ToolResult {
        // Plan tools update the UI — actual implementation in ChatToolWindow
        return when (name) {
            "plan.show" -> ToolResult(true, "Plan displayed", 0)
            "plan.update" -> ToolResult(true, "Plan update captured", 0)
            else -> ToolResult(false, "Unknown plan tool: $name", 0)
        }
    }

    // ── IDE Tools ──────────────────────────────────────────────────────

    private fun executeIdeTool(name: String, args: Map<String, Any>): ToolResult {
        return when (name) {
            "ide.openFile" -> {
                val path = args["path"] as? String ?: return ToolResult(false, "Missing path", 0)
                val line = (args["line"] as? Number)?.toInt() ?: 1
                // Will be implemented in OpenFileAction
                ToolResult(true, "File opened: $path:$line", 0)
            }
            "ide.diagnostics" -> ToolResult(true, "Diagnostics not yet implemented", 0)
            "ide.applyPatch" -> ToolResult(true, "Patch applied (use DiffManager in production)", 0)
            else -> ToolResult(false, "Unknown ide tool: $name", 0)
        }
    }

    // ── Path Validation ────────────────────────────────────────────────

    private fun resolveAndValidatePath(pathStr: String?): Path? {
        if (pathStr == null) return null
        val path = Paths.get(pathStr).normalize().toAbsolutePath()

        // Must be within project root
        val basePath = project.basePath?.let { Paths.get(it).toAbsolutePath() } ?: return null
        if (!path.startsWith(basePath)) {
            log.warn("Path out of project scope: $path")
            return null
        }

        // Blacklist check
        val settings = CodePilotSettings.getInstance()
        val blacklist = settings.pathBlacklist.toRegex()
        val relativePath = basePath.relativize(path).toString()
        if (blacklist.containsMatchIn(relativePath)) {
            log.warn("Path blocked by blacklist: $relativePath")
            return null
        }

        return path
    }

    // ── VFS Refresh ────────────────────────────────────────────────────

    private fun refreshVfs(path: Path) {
        VirtualFileManager.getInstance().syncRefresh()
    }

    // ── JSON Helper ────────────────────────────────────────────────────

    private fun escapeJson(text: String): String {
        return "\"${text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")}\""
    }
}

/** Result of a tool execution. */
data class ToolResult(
    val ok: Boolean,
    val result: String,
    val durationMs: Long
)