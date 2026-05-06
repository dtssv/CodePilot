package io.codepilot.plugin.vcs

import com.intellij.openapi.project.Project
import io.codepilot.plugin.transport.HttpClientService
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Generates a commit message by calling the backend `/v1/actions/commit-message` endpoint.
 * Also provides helper methods to extract git information (staged diff, branch, recent commits).
 */
object CommitMessageGenerator {

    private const val MAX_DIFF_LENGTH = 8000

    /**
     * Calls the backend to generate a commit message. Returns the generated text or null on failure.
     */
    fun generate(diff: String, branchName: String?, recentCommits: String?): String? {
        val http = HttpClientService.getInstance()
        val sessionId = UUID.randomUUID().toString()
        val payload = mapOf(
            "sessionId" to sessionId,
            "diff" to diff.take(MAX_DIFF_LENGTH),
            "branchName" to (branchName ?: "unknown"),
            "recentCommits" to recentCommits,
        )
        val request = http.postJson("/v1/actions/commit-message", payload)
        return try {
            val response = http.client().newCall(request).execute()
            response.use { resp ->
                if (!resp.isSuccessful) return null
                // SSE response: extract text from delta events
                val body = resp.body?.string() ?: return null
                extractTextFromSse(body)
            }
        } catch (_: IOException) {
            null
        }
    }

    /** Extracts concatenated text from SSE `delta` events. */
    private fun extractTextFromSse(sseBody: String): String? {
        val sb = StringBuilder()
        for (line in sseBody.lines()) {
            if (line.startsWith("data:")) {
                val data = line.removePrefix("data:").trim()
                // Try to extract text from delta event: {"text":"..."}
                val textMatch = Regex("\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(data)
                if (textMatch != null) {
                    val text = textMatch.groupValues[1]
                        .replace("\\n", "\n")
                        .replace("\\\"", "\"")
                        .replace("\\\\", "\\")
                    sb.append(text)
                }
            }
        }
        return sb.toString().trim().takeIf { it.isNotEmpty() }
    }

    /** Runs `git diff --cached` to get the staged changes. */
    fun getStagedDiff(project: Project): String? {
        return runGit(project, "diff", "--cached", "--no-color")
    }

    /** Gets the current branch name. */
    fun getCurrentBranch(project: Project): String? {
        return runGit(project, "rev-parse", "--abbrev-ref", "HEAD")?.trim()
    }

    /** Gets recent commit messages (last 5) for style reference. */
    fun getRecentCommitMessages(project: Project): String? {
        return runGit(project, "log", "--oneline", "-5", "--no-decorate")
    }

    private fun runGit(project: Project, vararg args: String): String? {
        val basePath = project.basePath ?: return null
        return try {
            val process = ProcessBuilder("git", *args)
                .directory(File(basePath))
                .redirectErrorStream(true)
                .start()
            val output = BufferedReader(InputStreamReader(process.inputStream)).use { it.readText() }
            val exited = process.waitFor(10, TimeUnit.SECONDS)
            if (exited && process.exitValue() == 0) {
                output.takeIf { it.isNotBlank() }
            } else {
                null
            }
        } catch (_: IOException) {
            null
        }
    }
}