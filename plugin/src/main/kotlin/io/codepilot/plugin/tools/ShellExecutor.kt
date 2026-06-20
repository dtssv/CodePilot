package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import io.codepilot.plugin.hooks.HookEngine
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import io.codepilot.plugin.shell.ShellGrantDecision
import io.codepilot.plugin.shell.ShellGrantWaiter
import io.codepilot.plugin.shell.ShellPolicy
import java.util.regex.Pattern

/**
 * Executes a single non-interactive shell command. OS-adapted (powershell on Windows, bash
 * elsewhere), with a hard timeout, stdout/stderr truncation, and a conservative denylist for
 * dangerous patterns.
 *
 * The caller is expected to have already prompted the user for risk-confirmation (the tool is
 * declared `risk=high` in the server-side schema).
 */
class ShellExecutor(
    private val project: Project,
) {
    fun execute(args: JsonNode): Map<String, Any?> {
        val command = args.path("command").asText("")
        if (command.isBlank()) throw ToolViolation("empty command")
        if (DENY.any { it.matcher(command).find() }) {
            throw ToolViolation("command blocked by denylist")
        }
        val timeoutMs = args.path("timeoutMs").asInt(60_000).coerceIn(1_000, 600_000)
        val cwd = ShellWorkingDirectory.resolve(project, args.path("cwd").asText(null))
        val osHint = args.path("osHint").asText(detectOs())
        val turnId = args.path("turnId").asText("system")
        val stepId = args.path("stepId").asText("shell-${System.nanoTime()}")

        val policy = ShellPolicy.getInstance(project)
        when (val decision = policy.decide(command, cwd)) {
            is ShellPolicy.Decision -> when (decision.action) {
                ShellPolicy.Action.DENY -> {
                    return denied(command, cwd, osHint, decision.reason)
                }
                ShellPolicy.Action.ASK -> {
                    when (askUser(command, cwd, decision.reason, turnId, stepId)) {
                        ShellGrantDecision.ALLOW -> Unit
                        ShellGrantDecision.DENY ->
                            return denied(command, cwd, osHint, "用户已拒绝执行此命令")
                        ShellGrantDecision.SKIP ->
                            return denied(command, cwd, osHint, "用户已跳过此命令", skipped = true)
                        null -> return denied(command, cwd, osHint, "等待确认超时")
                    }
                }
                ShellPolicy.Action.ALLOW -> Unit
            }
        }

        val hook = HookEngine.getInstance(project).run("beforeShellExecution", mapOf("command" to command, "cwd" to cwd))
        if (!hook.pass) return denied(command, cwd, osHint, hook.reason)

        return executeStreaming(command, cwd, osHint, timeoutMs, turnId, stepId)
    }

    private fun denied(command: String, cwd: String, osHint: String, reason: String, skipped: Boolean = false): Map<String, Any?> =
        mapOf(
            "exitCode" to -1,
            "timedOut" to false,
            "durationMs" to 0,
            "stdout" to "",
            "stderr" to "Denied: $reason",
            "os" to osHint,
            "cwd" to cwd,
            "command" to command,
            "userSkipped" to skipped,
        )

    private fun askUser(
        command: String,
        cwd: String,
        reason: String,
        turnId: String,
        stepId: String,
    ): ShellGrantDecision? {
        val token = "shell-ask-${System.nanoTime()}"
        EventBus.getInstance(project).emit(
            turnId,
            stepId,
            EventTypes.SHELL_ASK,
            mapOf(
                "token" to token,
                "stepId" to stepId,
                "command" to command,
                "cwd" to cwd,
                "reason" to reason,
            ),
        )
        return ShellGrantWaiter.awaitGrant(token, 5 * 60_000)
    }

    private fun executeStreaming(
        command: String,
        cwd: String,
        osHint: String,
        timeoutMs: Int,
        turnId: String,
        stepId: String,
    ): Map<String, Any?> {
        val startMs = System.currentTimeMillis()
        val proc = ProcessBuilder(buildArgv(command, osHint))
            .directory(java.io.File(cwd))
            .redirectErrorStream(false)
            .start()
        val stdout = StringBuilder()
        val stderr = StringBuilder()
        val bus = EventBus.getInstance(project)
        bus.toolProgress(
            turnId,
            stepId,
            mapOf(
                "kind" to "shell",
                "command" to command,
                "cwd" to cwd,
                "status" to "running",
                "startedAt" to startMs,
            ),
        )
        val outThread = Thread({
            proc.inputStream.bufferedReader().forEachLine { line ->
                stdout.append(line).append('\n')
                bus.emit(turnId, stepId, EventTypes.SHELL_PROGRESS, mapOf("stream" to "stdout", "line" to line))
                bus.toolProgress(turnId, stepId, mapOf("stream" to "stdout", "line" to line))
            }
        }, "CodePilot-shell-stdout")
        val errThread = Thread({
            proc.errorStream.bufferedReader().forEachLine { line ->
                stderr.append(line).append('\n')
                bus.emit(turnId, stepId, EventTypes.SHELL_PROGRESS, mapOf("stream" to "stderr", "line" to line))
                bus.toolProgress(turnId, stepId, mapOf("stream" to "stderr", "line" to line))
            }
        }, "CodePilot-shell-stderr")
        outThread.isDaemon = true
        errThread.isDaemon = true
        outThread.start()
        errThread.start()
        val completed = proc.waitFor(timeoutMs.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
        if (!completed) proc.destroy()
        outThread.join(1_000)
        errThread.join(1_000)
        val exitCode = if (completed) proc.exitValue() else -1
        return mapOf(
            "exitCode" to exitCode,
            "timedOut" to !completed,
            "durationMs" to (System.currentTimeMillis() - startMs),
            "stdout" to truncate(stdout.toString(), 64 * 1024),
            "stderr" to truncate(stderr.toString(), 16 * 1024),
            "os" to osHint,
            "cwd" to cwd,
            "command" to command,
        )
    }

    private fun legacyExecute(command: String, cwd: String, osHint: String, timeoutMs: Int): Map<String, Any?> {
        val cmdLine = buildCommandLine(command, cwd, osHint)
        val startMs = System.currentTimeMillis()
        val handler = CapturingProcessHandler(cmdLine)
        val output =
            handler.runProcessWithProgressIndicator(
                com.intellij.openapi.progress
                    .EmptyProgressIndicator(),
                timeoutMs,
                false,
            )
        val stdout = truncate(output.stdout, 64 * 1024)
        val stderr = truncate(output.stderr, 16 * 1024)
        return mapOf(
            "exitCode" to output.exitCode,
            "timedOut" to output.isTimeout,
            "durationMs" to (System.currentTimeMillis() - startMs),
            "stdout" to stdout,
            "stderr" to stderr,
            "os" to osHint,
            "cwd" to cwd,
        )
    }

    private fun buildArgv(command: String, os: String): List<String> {
        val adaptedCommand = if (os == "windows") adaptForWindows(command) else command
        return when (os) {
            "windows" -> listOf("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", adaptedCommand)
            else -> listOf("/bin/bash", "-lc", adaptedCommand)
        }
    }

    /**
     * ★ Adapt common bash-style commands for Windows PowerShell.
     * LLMs frequently generate bash commands regardless of the target OS.
     * This translates the most common patterns so they work on PowerShell.
     */
    private fun adaptForWindows(command: String): String {
        var cmd = command.trim()
        // python3 → python (Windows typically has `python` not `python3`)
        cmd = cmd.replace(Regex("""\bpython3\b"""), "python")
        // pip3 → pip
        cmd = cmd.replace(Regex("""\bpip3\b"""), "pip")
        // rm -rf dir → Remove-Item -Recurse -Force dir
        cmd = cmd.replace(Regex("""\brm\s+-rf\s+(\S+)""")) { "Remove-Item -Recurse -Force " + it.groupValues[1] }
        // rm file → Remove-Item file
        cmd = cmd.replace(Regex("""\brm\s+(\S+)""")) { "Remove-Item " + it.groupValues[1] }
        // mkdir -p dir → New-Item -ItemType Directory -Force dir
        cmd = cmd.replace(Regex("""\bmkdir\s+-p\s+(\S+)""")) { "New-Item -ItemType Directory -Force " + it.groupValues[1] }
        // cp src dst → Copy-Item src dst
        cmd = cmd.replace(Regex("""\bcp\s+"""), "Copy-Item ")
        // mv src dst → Move-Item src dst
        cmd = cmd.replace(Regex("""\bmv\s+"""), "Move-Item ")
        // touch file → New-Item -ItemType File file
        cmd = cmd.replace(Regex("""\btouch\s+(\S+)""")) { "New-Item -ItemType File " + it.groupValues[1] }
        // which → Get-Command
        cmd = cmd.replace(Regex("""\bwhich\s+"""), "Get-Command ")
        // grep → Select-String (basic translation)
        cmd = cmd.replace(Regex("""\bgrep\s+"""), "Select-String ")
        // echo $VAR → Write-Output $env:VAR  (PowerShell env variable syntax)
        cmd = cmd.replace(Regex("""\becho\s+\$(\w+)""")) {
            "Write-Output " + DOLLAR + "env:" + it.groupValues[1]
        }
        // export VAR=val → $env:VAR="val"
        cmd = cmd.replace(Regex("""\bexport\s+(\w+)=(\S+)""")) {
            DOLLAR + "env:" + it.groupValues[1] + "=\"" + it.groupValues[2] + "\""
        }
        return escapeForPowerShell(cmd)
    }

    /**
     * Best-effort fix for common bash-style escapes that LLMs emit on Windows.
     * Converts `\"` → `` `" `` and `\$` → `` `$ `` outside single-quoted strings.
     */
    private fun escapeForPowerShell(command: String): String {
        val result = StringBuilder()
        var inSingleQuotes = false
        var i = 0
        while (i < command.length) {
            val c = command[i]
            if (c == '\'' && !inSingleQuotes) {
                inSingleQuotes = true
                result.append(c)
                i++
                continue
            }
            if (c == '\'' && inSingleQuotes) {
                inSingleQuotes = false
                result.append(c)
                i++
                continue
            }
            if (!inSingleQuotes && c == '\\' && i + 1 < command.length) {
                when (command[i + 1]) {
                    '"' -> {
                        result.append("`\"")
                        i += 2
                        continue
                    }
                    '$' -> {
                        result.append("`\$")
                        i += 2
                        continue
                    }
                }
            }
            result.append(c)
            i++
        }
        return result.toString()
    }

    private fun buildCommandLine(
        command: String,
        cwd: String,
        os: String,
    ): GeneralCommandLine {
        val adaptedCommand = if (os == "windows") adaptForWindows(command) else command
        val line = GeneralCommandLine()
        line.setWorkDirectory(cwd)
        line.charset = Charsets.UTF_8
        when (os) {
            "windows" -> {
                line.exePath = "powershell.exe"
                line.addParameters("-NoProfile", "-NonInteractive", "-Command", adaptedCommand)
            }
            else -> {
                line.exePath = "/bin/bash"
                line.addParameters("-lc", adaptedCommand)
            }
        }
        return line
    }

    private fun detectOs(): String =
        when {
            SystemInfo.isWindows -> "windows"
            SystemInfo.isMac -> "macos"
            else -> "linux"
        }

    private fun truncate(
        text: String,
        maxBytes: Int,
    ): String {
        val bytes = text.toByteArray()
        if (bytes.size <= maxBytes) return text
        return String(bytes, 0, maxBytes, Charsets.UTF_8) + "\n[...truncated...]"
    }

    companion object {
        /** Dollar sign literal — avoids Kotlin string template interpretation in PowerShell commands. */
        private val DOLLAR = "\$"

        private val DENY =
            listOf(
                Pattern.compile("""rm\s+-rf\s+/(\s|$)"""),
                Pattern.compile("""mkfs\.\w+"""),
                Pattern.compile("""(?i)\bshutdown\b"""),
                Pattern.compile("""(?i)\breboot\b"""),
                Pattern.compile("""(?i)\bformat\s+[a-z]:"""),
                Pattern.compile("""dd\s+if=\S+\s+of=/dev/"""),
                Pattern.compile(""":\(\)\s*\{\s*:\|:&\s*};:"""), // fork bomb
            )

        data class ExecuteResult(
            val exitCode: Int,
            val stdout: String,
            val stderr: String,
            val timedOut: Boolean,
        )

        /**
         * Convenience method to execute a shell command without JsonNode args.
         */
        fun execute(project: Project, command: String, cwd: String? = null, timeoutMs: Int = 60_000): ExecuteResult {
            val workDir = cwd ?: project.basePath ?: "."
            val os = when {
                SystemInfo.isWindows -> "windows"
                SystemInfo.isMac -> "macos"
                else -> "linux"
            }
            val cmdLine = GeneralCommandLine()
            cmdLine.setWorkDirectory(workDir)
            cmdLine.charset = Charsets.UTF_8
            when (os) {
                "windows" -> {
                    cmdLine.exePath = "powershell.exe"
                    cmdLine.addParameters("-NoProfile", "-NonInteractive", "-Command", command)
                }
                else -> {
                    cmdLine.exePath = "/bin/bash"
                    cmdLine.addParameters("-lc", command)
                }
            }
            val handler = CapturingProcessHandler(cmdLine)
            val output = handler.runProcessWithProgressIndicator(
                com.intellij.openapi.progress.EmptyProgressIndicator(),
                timeoutMs,
                false,
            )
            return ExecuteResult(
                exitCode = output.exitCode,
                stdout = output.stdout,
                stderr = output.stderr,
                timedOut = output.isTimeout,
            )
        }
    }
}
