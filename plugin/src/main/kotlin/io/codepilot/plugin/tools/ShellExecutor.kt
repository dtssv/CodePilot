package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.util.regex.Pattern

/**
 * Executes a single non-interactive shell command. OS-adapted (powershell on Windows, bash
 * elsewhere), with a hard timeout, stdout/stderr truncation, and a conservative denylist for
 * dangerous patterns.
 *
 * The caller is expected to have already prompted the user for risk-confirmation (the tool is
 * declared `risk=high` in the server-side schema).
 */
class ShellExecutor(private val project: Project) {

    fun execute(args: JsonNode): Map<String, Any?> {
        val command = args.path("command").asText("")
        if (command.isBlank()) throw ToolViolation("empty command")
        if (DENY.any { it.matcher(command).find() }) {
            throw ToolViolation("command blocked by denylist")
        }
        val timeoutMs = args.path("timeoutMs").asInt(60_000).coerceIn(1_000, 600_000)
        val cwd = args.path("cwd").asText("").ifBlank { project.basePath ?: "." }
        val osHint = args.path("osHint").asText(detectOs())

        val cmdLine = buildCommandLine(command, cwd, osHint)
        val handler = CapturingProcessHandler(cmdLine)
        val output = handler.runProcessWithProgressIndicator(
            com.intellij.openapi.progress.EmptyProgressIndicator(),
            timeoutMs,
            false,
        )
        val stdout = truncate(output.stdout, 64 * 1024)
        val stderr = truncate(output.stderr, 16 * 1024)
        return mapOf(
            "exitCode" to output.exitCode,
            "timedOut" to output.isTimeout,
            "durationMs" to output.executionTime,
            "stdout" to stdout,
            "stderr" to stderr,
            "os" to osHint,
            "cwd" to cwd,
        )
    }

    private fun buildCommandLine(command: String, cwd: String, os: String): GeneralCommandLine {
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

    private fun truncate(text: String, maxBytes: Int): String {
        val bytes = text.toByteArray()
        if (bytes.size <= maxBytes) return text
        return String(bytes, 0, maxBytes, Charsets.UTF_8) + "\n[...truncated...]"
    }

    companion object {
        private val DENY = listOf(
            Pattern.compile("""rm\s+-rf\s+/(\s|$)"""),
            Pattern.compile("""mkfs\.\w+"""),
            Pattern.compile("""(?i)\bshutdown\b"""),
            Pattern.compile("""(?i)\breboot\b"""),
            Pattern.compile("""(?i)\bformat\s+[a-z]:"""),
            Pattern.compile("""dd\s+if=\S+\s+of=/dev/"""),
            Pattern.compile(""":\(\)\s*\{\s*:\|:&\s*};:"""), // fork bomb
        )
    }
}