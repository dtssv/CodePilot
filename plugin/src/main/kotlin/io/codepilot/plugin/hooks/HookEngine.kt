package io.codepilot.plugin.hooks

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import io.codepilot.plugin.tools.ShellExecutor
import java.nio.file.Files
import java.nio.file.Path

@Service(Service.Level.PROJECT)
class HookEngine(private val project: Project) {
    data class Hook(
        val id: String,
        val event: String,
        val command: String,
        val enabled: Boolean = true,
        val timeoutMs: Int = 30_000,
    )

    data class Result(
        val pass: Boolean,
        val reason: String,
        val ran: Int = 0,
    )

    private val mapper: ObjectMapper = jacksonObjectMapper()

    fun list(): List<Hook> = readHooks()

    fun run(event: String, context: Map<String, Any?>): Result {
        val hooks = readHooks().filter { it.enabled && it.event == event }
        var ran = 0
        for (h in hooks) {
            ran++
            val cmd = render(h.command, context)
            val res = ShellExecutor.execute(project, cmd, project.basePath, h.timeoutMs)
            val ok = res.exitCode == 0 && !res.timedOut
            EventBus.getInstance(project).emit(
                turnId = "system",
                stepId = "hook-${h.id}",
                type = EventTypes.HOOK_RESULT,
                payload = mapOf("id" to h.id, "event" to event, "ok" to ok, "exitCode" to res.exitCode, "stdout" to res.stdout, "stderr" to res.stderr),
            )
            if (!ok) return Result(false, "hook ${h.id} failed: ${res.stderr.ifBlank { res.stdout }}", ran)
        }
        return Result(true, "ok", ran)
    }

    fun writeHooks(hooks: List<Hook>) {
        val p = hooksPath() ?: return
        Files.createDirectories(p.parent)
        mapper.writerWithDefaultPrettyPrinter().writeValue(p.toFile(), mapOf("hooks" to hooks))
    }

    private fun readHooks(): List<Hook> {
        val p = hooksPath() ?: return emptyList()
        if (!Files.exists(p)) return emptyList()
        val root = mapper.readTree(Files.readString(p))
        val arr = root.path("hooks")
        if (!arr.isArray) return emptyList()
        return arr.map {
            Hook(
                id = it.path("id").asText("hook-${System.nanoTime()}"),
                event = it.path("event").asText("beforeSubmitPrompt"),
                command = it.path("command").asText(""),
                enabled = it.path("enabled").asBoolean(true),
                timeoutMs = it.path("timeoutMs").asInt(30_000).coerceIn(1_000, 300_000),
            )
        }.filter { it.command.isNotBlank() }
    }

    private fun render(command: String, context: Map<String, Any?>): String {
        var out = command
        for ((k, v) in context) out = out.replace("{{${k}}}", v?.toString() ?: "")
        return out
    }

    private fun hooksPath(): Path? = project.basePath?.let { Path.of(it, ".codepilot", "hooks.json") }

    companion object {
        fun getInstance(project: Project): HookEngine = project.service()
    }
}
