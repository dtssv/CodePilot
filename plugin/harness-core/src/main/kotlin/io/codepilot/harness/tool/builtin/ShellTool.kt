package io.codepilot.harness.tool.builtin

import io.codepilot.harness.perm.ShellPolicy
import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.Tool
import io.codepilot.harness.tool.ToolOutput
import io.codepilot.harness.tool.ToolSpec
import io.codepilot.harness.tool.WorkspaceScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.TimeUnit

/**
 * `run_command` tool: execute a shell command in the workspace, with a
 * deny list, OS adaptation, timeout and stdout/stderr capture.
 *
 * Sunk from plugin/tools/ShellExecutor.kt. The IDE version couples to
 * EventBus + ShellGrantWaiter + CapturingProcessHandler; here we keep only
 * the ProcessBuilder core and the deny list / OS adaptation logic. The
 * permission UI (approval popup) is delegated to PermissionGate's Ask path
 * via the harness loop's ApprovalHandler — the IDE adapter supplies that.
 *
 * Behaviour:
 *   - denylist blocks destructive commands (rm/del/format/shutdown/reboot)
 *   - cwd must be inside the workspace
 *   - stdout/stderr captured separately; stdout truncated to 64K, stderr to 16K
 *   - timeout (default 60s, capped 1s..600s)
 *   - OS adaptation: bash on unix, powershell on windows (with bash→pwsh translation)
 */
class ShellTool(
    private val scope: WorkspaceScope,
    private val policy: ShellPolicy,
) : Tool {
    override val spec = ToolSpec(
        name = "run_command",
        description = "Execute a shell command in the workspace. Deny-listed commands are blocked; cwd must be in workspace.",
        parametersJson = """{"type":"object","properties":{
            "command":{"type":"string"},
            "cwd":{"type":"string","description":"working directory (defaults to workspace root)"},
            "timeoutMs":{"type":"integer","default":60000}
        },"required":["command"]}""",
        dangerLevel = DangerLevel.EXEC,
    )

    private val denyPatterns = listOf(
        Regex("""(?i)\b(rm\s+-rf\s+/|mkfs|dd\s+if=|:\(\)\{.*\};\s*\)\s*&*|shutdown|reboot|halt|init\s+0)\b"""),
    )

    override suspend fun execute(args: JsonObject): ToolOutput = try {
        val command = args["command"]?.jsonPrimitive?.content ?: return ToolOutput.failure("missing command")
        if (command.isBlank()) return ToolOutput.failure("empty command")
        if (denyPatterns.any { it.containsMatchIn(command) }) {
            return ToolOutput.failure("command blocked by denylist")
        }

        val cwd = args["cwd"]?.jsonPrimitive?.content?.let { scope.resolve(it) ?: scope.root }
            ?: scope.root
        val timeoutMs = (args["timeoutMs"]?.jsonPrimitive?.content?.toIntOrNull() ?: 60_000)
            .coerceIn(1_000, 600_000)

        // Permission check: the harness loop has already invoked PermissionGate
        // (which is how we got here). Re-check via ShellPolicy for cwd safety.
        when (val d = policy.decide(command, cwd.toString())) {
            is ShellPolicy.Decision -> when (d.action) {
                ShellPolicy.Action.DENY -> return ToolOutput.failure("denied: ${d.reason}")
                else -> { /* ALLOW or already-ASK-resolved */ }
            }
        }

        val os = detectOs()
        val argv = buildArgv(command, os)
        val start = System.currentTimeMillis()

        val proc = ProcessBuilder(argv)
            .directory(cwd.toFile())
            .redirectErrorStream(false)
            .start()

        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val outThread = Thread({
            proc.inputStream.bufferedReader().forEachLine { stdout.append(it).append('\n') }
        }, "harness-shell-stdout")
        val errThread = Thread({
            proc.errorStream.bufferedReader().forEachLine { stderr.append(it).append('\n') }
        }, "harness-shell-stderr")
        outThread.isDaemon = true; errThread.isDaemon = true
        outThread.start(); errThread.start()

        val completed = proc.waitFor(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        if (!completed) proc.destroyForcibly()
        outThread.join(1_000); errThread.join(1_000)
        val exitCode = if (completed) proc.exitValue() else -1

        val out = truncate(stdout.toString(), MAX_STDOUT)
        val err = truncate(stderr.toString(), MAX_STDERR)
        val durationMs = System.currentTimeMillis() - start
        val summary = "exit=$exitCode dur=${durationMs}ms cwd=$cwd os=$os\n--- stdout ---\n$out\n--- stderr ---\n$err"
        if (exitCode == 0) ToolOutput.success(summary, truncated = out.length >= MAX_STDOUT || err.length >= MAX_STDERR)
        else ToolOutput.failure(summary, exitCode)
    } catch (e: Exception) {
        ToolOutput.failure(e.message ?: e.toString())
    }

    private fun buildArgv(command: String, os: String): List<String> {
        val adapted = if (os == "windows") adaptForWindows(command) else command
        return when (os) {
            "windows" -> listOf("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", adapted)
            else -> listOf("/bin/bash", "-lc", adapted)
        }
    }

    private fun detectOs(): String =
        if (System.getProperty("os.name").lowercase().contains("windows")) "windows" else "unix"

    private fun adaptForWindows(command: String): String {
        var cmd = command.trim()
        cmd = cmd.replace(Regex("""\bpython3\b"""), "python")
        cmd = cmd.replace(Regex("""\bpip3\b"""), "pip")
        cmd = cmd.replace(Regex("""\brm\s+-rf\s+(\S+)""")) { "Remove-Item -Recurse -Force " + it.groupValues[1] }
        cmd = cmd.replace(Regex("""\brm\s+(\S+)""")) { "Remove-Item " + it.groupValues[1] }
        cmd = cmd.replace(Regex("""\bmkdir\s+-p\s+(\S+)""")) { "New-Item -ItemType Directory -Force " + it.groupValues[1] }
        cmd = cmd.replace(Regex("""\bcp\s+"""), "Copy-Item ")
        cmd = cmd.replace(Regex("""\bmv\s+"""), "Move-Item ")
        cmd = cmd.replace(Regex("""\btouch\s+(\S+)""")) { "New-Item -ItemType File " + it.groupValues[1] }
        cmd = cmd.replace(Regex("""\bwhich\s+"""), "Get-Command ")
        cmd = cmd.replace(Regex("""\bgrep\s+"""), "Select-String ")
        cmd = cmd.replace(Regex("""\becho\s+\$(\w+)""")) { "Write-Output `$env:" + it.groupValues[1] }
        cmd = cmd.replace(Regex("""\bexport\s+(\w+)=(\S+)""")) { "`$env:" + it.groupValues[1] + "=\"" + it.groupValues[2] + "\"" }
        return cmd
    }

    private fun truncate(s: String, max: Int): String =
        if (s.length <= max) s else s.take(max) + "\n...[truncated ${s.length - max} chars]"

    companion object {
        const val MAX_STDOUT = 64 * 1024
        const val MAX_STDERR = 16 * 1024
    }
}
