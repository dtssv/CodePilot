package io.codepilot.plugin.shell

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

@Service(Service.Level.PROJECT)
class ShellPolicy(private val project: Project) {
    enum class Action { ALLOW, DENY, ASK }
    data class Rule(val pattern: Regex, val action: Action)
    data class Decision(val action: Action, val reason: String)

    private val mapper: ObjectMapper = jacksonObjectMapper()
    private val sessionAllowed = ConcurrentHashMap.newKeySet<String>()

    @Volatile private var defaultAction = Action.ASK
    @Volatile private var rules: List<Rule> = defaultRules()

    fun reload(): Map<String, Any?> {
        val p = policyPath() ?: return snapshot()
        if (!Files.exists(p)) {
            writeDefault()
            return snapshot()
        }
        val root = mapper.readTree(Files.readString(p))
        defaultAction = parseAction(root.path("defaultAction").asText("ask"))
        val parsed = root.path("rules").takeIf { it.isArray }?.mapNotNull {
            val pattern = it.path("pattern").asText("")
            if (pattern.isBlank()) null else Rule(pattern.toRegex(), parseAction(it.path("action").asText("ask")))
        } ?: defaultRules()
        rules = parsed
        return snapshot()
    }

    fun decide(command: String, cwd: String): Decision {
        reload()
        if (sessionAllowed.contains(command)) return Decision(Action.ALLOW, "session grant")
        val base = project.basePath ?: "."
        val normalized = Path.of(cwd).toAbsolutePath().normalize()
        val root = Path.of(base).toAbsolutePath().normalize()
        if (!normalized.startsWith(root)) return Decision(Action.DENY, "cwd outside workspace: $cwd")
        val match = rules.firstOrNull { it.pattern.containsMatchIn(command) }
        return if (match != null) Decision(match.action, "rule: ${match.pattern.pattern}")
        else Decision(defaultAction, "default")
    }

    fun rememberAllow(command: String) {
        sessionAllowed.add(command)
    }

    fun snapshot(): Map<String, Any?> =
        mapOf(
            "defaultAction" to defaultAction.name.toLowerCase(),
            "rules" to rules.map { mapOf("pattern" to it.pattern.pattern, "action" to it.action.name.toLowerCase()) },
        )

    fun writePolicy(defaultAction: String, rules: List<Map<String, String>>) {
        val p = policyPath() ?: return
        Files.createDirectories(p.parent)
        mapper.writerWithDefaultPrettyPrinter().writeValue(
            p.toFile(),
            mapOf("defaultAction" to defaultAction, "rules" to rules),
        )
        reload()
    }

    private fun writeDefault() {
        val p = policyPath() ?: return
        Files.createDirectories(p.parent)
        mapper.writerWithDefaultPrettyPrinter().writeValue(
            p.toFile(),
            mapOf(
                "defaultAction" to "ask",
                "rules" to defaultRules().map { mapOf("pattern" to it.pattern.pattern, "action" to it.action.name.toLowerCase()) },
                "cwdWhitelist" to listOf("\${workspace}", "\${workspace}/**"),
            ),
        )
    }

    private fun parseAction(s: String): Action =
        when (s.toLowerCase()) {
            "allow" -> Action.ALLOW
            "deny" -> Action.DENY
            else -> Action.ASK
        }

    private fun defaultRules(): List<Rule> =
        listOf(
            Rule("""^git (status|log|diff|show)( |$)""".toRegex(), Action.ALLOW),
            Rule("""^(pwd|echo|ls|dir)( |$)""".toRegex(), Action.ALLOW),
            Rule("""(?i)\b(rm|del|format|shutdown|reboot)\b""".toRegex(), Action.DENY),
            Rule(""".*(>|>>|\|).*""".toRegex(), Action.ASK),
            Rule("""^curl( |$)|^wget( |$)""".toRegex(), Action.ASK),
        )

    private fun policyPath(): Path? = project.basePath?.let { Path.of(it, ".codepilot", "shell-policy.json") }

    companion object {
        fun getInstance(project: Project): ShellPolicy = project.service()
    }
}
