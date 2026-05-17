package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.SystemInfo
import io.codepilot.plugin.hooks.HookEngine
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
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
        val cwd = args.path("cwd").asText("").ifBlank { project.basePath ?: "." }
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
                    val allow = askUser(command, cwd, decision.reason)
                    if (!allow) return denied(command, cwd, osHint, "user denied: ${decision.reason}")
                }
                ShellPolicy.Action.ALLOW -> Unit
            }
        }

        val hook = HookEngine.getInstance(project).run("beforeShellExecution", mapOf("command" to command, "cwd" to cwd))
        if (!hook.pass) return denied(command, cwd, osHint, hook.reason)

        return executeStreaming(command, cwd, osHint, timeoutMs, turnId, stepId)
    }

    private fun denied(command: String, cwd: String, osHint: String, reason: String): Map<String, Any?> =
        mapOf(
            "exitCode" to -1,
            "timedOut" to false,
            "durationMs" to 0,
            "stdout" to "",
            "stderr" to "Denied: $reason",
            "os" to osHint,
            "cwd" to cwd,
            "command" to command,
        )

    private fun askUser(command: String, cwd: String, reason: String): Boolean {
        val app = ApplicationManager.getApplication()
        val result = java.util.concurrent.atomic.AtomicInteger(Messages.CANCEL)
        val action = {
            result.set(
                Messages.showOkCancelDialog(
                    project,
                    "Allow CodePilot to run this shell command?\n\n$command\n\ncwd: $cwd\nreason: $reason",
                    "CodePilot Shell Permission",
                    "Allow",
                    "Deny",
                    Messages.getWarningIcon(),
                ),
            )
        }
        if (app.isDispatchThread) action() else app.invokeAndWait(action)
        return result.get() == Messages.OK
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
        return mapOf(
            "exitCode" to if (completed) proc.exitValue() else -1,
            "timedOut" to !completed,
            "durationMs" to (System.currentTimeMillis() - startMs),
            "stdout" to truncate(stdout.toString(), 64 * 1024),
            "stderr" to truncate(stderr.toString(), 16 * 1024),
            "os" to osHint,
            "cwd" to cwd,
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

    private fun buildArgv(command: String, os: String): List<String> =
        when (os) {
            "windows" -> listOf("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
            else -> listOf("/bin/bash", "-lc", command)
        }

    private fun buildCommandLine(
        command: String,
        cwd: String,
        os: String,
    ): GeneralCommandLine {
        val line = GeneralCommandLine()
        line.setWorkDirectory(cwd)
        line.charset = Charsets.UTF_8
        when (os) {
            "windows" -> {
                line.exePath = "powershell.exe"
                line.addParameters("-NoProfile", "-NonInteractive", "-Command", command)
            }
            else -> {
                line.exePath = "/bin/bash"
                line.addParameters("-lc", command)
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
