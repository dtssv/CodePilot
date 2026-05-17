package io.codepilot.plugin.background

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.conversation.ConversationClient
import com.fasterxml.jackson.databind.JsonNode
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@Service(Service.Level.PROJECT)
class BackgroundTaskManager(private val project: Project) {
    data class Outputs(
        var commits: List<String> = emptyList(),
        var diffStat: String = "",
        var prUrl: String? = null,
        var logPath: String? = null,
    )

    data class Task(
        val id: String,
        val title: String,
        val prompt: String,
        var status: String,
        val worktreePath: String,
        val branchName: String,
        val baseRef: String,
        val sessionId: String,
        val createdAt: Long,
        var endedAt: Long? = null,
        val outputs: Outputs = Outputs(),
    )

    private val tasks = ConcurrentHashMap<String, Task>()
    private val client = ConversationClient()
    @Volatile private var dispatcher: ((String, Any) -> Unit)? = null

    fun setDispatcher(dispatcher: ((String, Any) -> Unit)?) {
        this.dispatcher = dispatcher
    }

    fun submit(title: String, prompt: String): Task {
        val root = Path.of(project.basePath ?: error("Project basePath is unavailable"))
        val id = "bg-${UUID.randomUUID().toString().take(8)}"
        val branch = "codepilot/task-$id"
        val baseRef = runGit(root, "rev-parse", "HEAD").trim()
        val worktree = root.resolve(".codepilot").resolve("worktrees").resolve(id)
        Files.createDirectories(worktree.parent)
        runGit(root, "worktree", "add", "-b", branch, worktree.toString(), baseRef)

        val task = Task(
            id = id,
            title = title.ifBlank { prompt.take(48).ifBlank { id } },
            prompt = prompt,
            status = "queued",
            worktreePath = worktree.toString(),
            branchName = branch,
            baseRef = baseRef,
            sessionId = "bg-session-$id",
            createdAt = System.currentTimeMillis(),
        )
        task.outputs.logPath = worktree.resolve(".codepilot").resolve("background.log").toString()
        tasks[id] = task
        emit()
        ApplicationManager.getApplication().executeOnPooledThread { runTask(task) }
        return task
    }

    fun list(): List<Task> = tasks.values.sortedByDescending { it.createdAt }

    fun cancel(id: String) {
        val task = tasks[id] ?: return
        if (task.status == "queued" || task.status == "running") {
            client.stop(task.sessionId)
            task.status = "cancelled"
            task.endedAt = System.currentTimeMillis()
            appendLog(task, "cancelled")
            emit()
        }
    }

    fun merge(id: String, strategy: String = "squash"): Map<String, Any?> {
        val task = tasks[id] ?: return mapOf("ok" to false, "error" to "task not found")
        if (task.status != "completed") return mapOf("ok" to false, "error" to "task is not completed")
        val root = Path.of(project.basePath ?: return mapOf("ok" to false, "error" to "project basePath unavailable"))
        return runCatching {
            when (strategy) {
                "merge" -> runGit(root, "merge", "--no-ff", task.branchName, "-m", "Merge ${task.branchName}")
                else -> {
                    runGit(root, "merge", "--squash", task.branchName)
                    runGit(root, "commit", "-m", "codepilot: ${task.title}")
                }
            }
            mapOf("ok" to true)
        }.getOrElse { mapOf("ok" to false, "error" to (it.message ?: "merge failed")) }
    }

    fun discard(id: String): Map<String, Any?> {
        val task = tasks[id] ?: return mapOf("ok" to false, "error" to "task not found")
        cancel(id)
        val root = Path.of(project.basePath ?: return mapOf("ok" to false, "error" to "project basePath unavailable"))
        runCatching { runGit(root, "worktree", "remove", "--force", task.worktreePath) }
        runCatching { runGit(root, "branch", "-D", task.branchName) }
        tasks.remove(id)
        emit()
        return mapOf("ok" to true)
    }

    fun openWorktree(id: String): Map<String, Any?> {
        val task = tasks[id] ?: return mapOf("ok" to false, "error" to "task not found")
        val file = java.io.File(task.worktreePath)
        return runCatching {
            com.intellij.ide.impl.ProjectUtil.openOrImport(file.toPath(), project, false)
            mapOf("ok" to true)
        }.getOrElse { mapOf("ok" to false, "error" to (it.message ?: "open failed")) }
    }

    private fun runTask(task: Task) {
        task.status = "running"
        appendLog(task, "started at ${Instant.now()}")
        emit()
        val wrappedPrompt = """
            You are running as a CodePilot Background Agent in an isolated git worktree.
            Worktree: ${task.worktreePath}
            Branch: ${task.branchName}

            User task:
            ${task.prompt}

            Produce a concise implementation plan and complete as much as possible without blocking
            the user's main IDE session. If code changes are required, describe the exact files and
            edits in a final summary so they can be applied or reviewed from this worktree.
        """.trimIndent()
        val toolDispatcher = WorktreeToolDispatcher(Path.of(task.worktreePath), client, task.sessionId) { appendLog(task, it) }
        client.run(
            mapOf("sessionId" to task.sessionId, "mode" to "agent", "input" to wrappedPrompt, "intent" to "new"),
            object : ConversationClient.Listener {
                override fun onDelta(text: String) = onEvent(task, "delta", mapOf("text" to text))

                override fun onToolCall(payload: JsonNode) {
                    onEvent(task, "tool_call", payload.toString())
                    toolDispatcher.dispatch(payload)
                }

                override fun onToolResultAck(payload: JsonNode) = onEvent(task, "tool_result_ack", payload.toString())

                override fun onNeedsInput(payload: JsonNode) {
                    task.status = "needs_input"
                    onEvent(task, "needs_input", payload.toString())
                    emit()
                }

                override fun onError(code: Int, message: String) {
                    task.status = "failed"
                    task.endedAt = System.currentTimeMillis()
                    onEvent(task, "error", mapOf("code" to code, "message" to message))
                    emit()
                }

                override fun onDone(reason: String, payload: JsonNode) {
                    onEvent(task, "done", mapOf("reason" to reason))
                    finishTask(task)
                }

                override fun onClosed() {
                    if (task.status == "running") {
                        task.status = "failed"
                        task.endedAt = System.currentTimeMillis()
                        onEvent(task, "closed", "stream closed")
                        emit()
                    }
                }
            },
        )
    }

    private fun onEvent(task: Task, eventType: String, data: Any?) {
        appendLog(task, "[$eventType] $data")
        emitLog(task, eventType, data)
    }

    private fun finishTask(task: Task) {
        if (task.status == "cancelled") return
        val worktree = Path.of(task.worktreePath)
        task.outputs.diffStat = runCatching { runGit(worktree, "diff", "--stat", task.baseRef) }.getOrDefault("").trim()
        task.outputs.commits = runCatching {
            runGit(worktree, "log", "${task.baseRef}..HEAD", "--format=%H %s")
                .lines()
                .filter { it.isNotBlank() }
        }.getOrDefault(emptyList())
        task.status = "completed"
        task.endedAt = System.currentTimeMillis()
        appendLog(task, "completed at ${Instant.now()}")
        emit()
    }

    private fun appendLog(task: Task, line: String) {
        val path = Path.of(task.outputs.logPath ?: return)
        Files.createDirectories(path.parent)
        Files.writeString(path, line + "\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND)
    }

    private fun emitLog(task: Task, eventType: String, data: Any?) {
        dispatcher?.invoke("bg.log", mapOf("taskId" to task.id, "eventType" to eventType, "data" to data))
    }

    private fun emit() {
        dispatcher?.invoke("bg.tasks.update", mapOf("tasks" to list().map { it.toDto() }))
    }

    private fun Task.toDto(): Map<String, Any?> = mapOf(
        "id" to id,
        "title" to title,
        "prompt" to prompt,
        "status" to status,
        "worktreePath" to worktreePath,
        "branchName" to branchName,
        "baseRef" to baseRef,
        "sessionId" to sessionId,
        "createdAt" to createdAt,
        "endedAt" to endedAt,
        "outputs" to mapOf(
            "commits" to outputs.commits,
            "diffStat" to outputs.diffStat,
            "prUrl" to outputs.prUrl,
            "logPath" to outputs.logPath,
        ),
    )

    private fun runGit(cwd: Path, vararg args: String): String {
        val proc = ProcessBuilder(listOf("git") + args)
            .directory(cwd.toFile())
            .redirectErrorStream(true)
            .start()
        val out = proc.inputStream.bufferedReader().readText()
        val code = proc.waitFor()
        if (code != 0) error("git ${args.joinToString(" ")} failed: $out")
        return out
    }

    companion object {
        fun getInstance(project: Project): BackgroundTaskManager = project.service()
    }
}
