package io.codepilot.harness.perm

import java.nio.file.Files
import java.nio.file.Path
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * Declarative shell command policy: a rule table of (pattern × Action).
 *
 * Sunk from plugin/shell/ShellPolicy.kt. The original is a IntelliJ
 * `@Service(Level.PROJECT)` coupled to `Project.basePath` and Jackson. This
 * version is plain Kotlin with kotlinx.serialization; the IDE adapter injects
 * the workspace root and the policy file path.
 *
 * The rule table is JSON (`.codepilot/shell-policy.json`):
 * ```
 * {"defaultAction":"ask","rules":[
 *   {"pattern":"^git (status|log|diff|show)( |$)","action":"allow"},
 *   {"pattern":"(?i)\\b(rm|del|format)\\b","action":"deny"}
 * ]}
 * ```
 *
 * Decision logic: first matching rule wins; cwd must be under [workspaceRoot];
 * otherwise defaultAction.
 */
class ShellPolicy(
    private val workspaceRoot: Path,
    private val policyPath: Path? = null,
) {
    enum class Action { ALLOW, DENY, ASK }
    data class Rule(val pattern: Regex, val action: Action)
    data class Decision(val action: Action, val reason: String)

    @Serializable
    private data class RuleSerde(val pattern: String, val action: String)

    @Serializable
    private data class PolicySerde(val defaultAction: String = "ask", val rules: List<RuleSerde> = emptyList())

    private val json = Json { ignoreUnknownKeys = true }
    private val sessionAllowed = mutableSetOf<String>()

    @Volatile private var defaultAction = Action.ASK
    @Volatile private var rules: List<Rule> = defaultRules()

    init {
        reload()
    }

    fun reload() {
        val p = policyPath ?: return
        if (!Files.exists(p)) {
            writeDefault()
            return
        }
        val root = runCatching { json.decodeFromString(PolicySerde.serializer(), Files.readString(p)) }.getOrNull()
            ?: return
        defaultAction = parseAction(root.defaultAction)
        rules = root.rules.mapNotNull {
            if (it.pattern.isBlank()) null else Rule(it.pattern.toRegex(), parseAction(it.action))
        }.ifEmpty { defaultRules() }
    }

    fun decide(command: String, cwd: String): Decision {
        if (sessionAllowed.contains(command)) return Decision(Action.ALLOW, "session grant")
        val normalized = Path.of(cwd).toAbsolutePath().normalize()
        val root = workspaceRoot.toAbsolutePath().normalize()
        if (!normalized.startsWith(root)) {
            return Decision(Action.DENY, "cwd outside workspace: $cwd")
        }
        val match = rules.firstOrNull { it.pattern.containsMatchIn(command) }
        return if (match != null) Decision(match.action, "rule: ${match.pattern.pattern}")
        else Decision(defaultAction, "default")
    }

    fun rememberAllow(command: String) { sessionAllowed.add(command) }

    fun snapshot(): Map<String, Any?> = mapOf(
        "defaultAction" to defaultAction.name.lowercase(),
        "rules" to rules.map { mapOf("pattern" to it.pattern.pattern, "action" to it.action.name.lowercase()) },
    )

    fun writePolicy(defaultAction: String, rules: List<Map<String, String>>) {
        val p = policyPath ?: return
        Files.createDirectories(p.parent)
        val serde = PolicySerde(
            defaultAction = defaultAction,
            rules = rules.mapNotNull { r ->
                val pat = r["pattern"] ?: return@mapNotNull null
                RuleSerde(pat, r["action"] ?: "ask")
            }
        )
        Files.writeString(p, json.encodeToString(PolicySerde.serializer(), serde))
        reload()
    }

    private fun writeDefault() {
        val p = policyPath ?: return
        Files.createDirectories(p.parent)
        val serde = PolicySerde(
            defaultAction = "ask",
            rules = defaultRules().map { RuleSerde(it.pattern.pattern, it.action.name.lowercase()) },
        )
        Files.writeString(p, json.encodeToString(PolicySerde.serializer(), serde))
    }

    private fun parseAction(s: String): Action = when (s.lowercase()) {
        "allow" -> Action.ALLOW
        "deny" -> Action.DENY
        else -> Action.ASK
    }

    private fun defaultRules(): List<Rule> = listOf(
        Rule("""^git (status|log|diff|show)( |$)""".toRegex(), Action.ALLOW),
        Rule("""^(pwd|echo|ls|dir)( |$)""".toRegex(), Action.ALLOW),
        Rule("""^(mkdir|cmake|make|ninja|g\+\+|gcc|clang\+\+|clang|cargo|go|python3?|node|npm|mvn|gradle)( |$)""".toRegex(), Action.ALLOW),
        Rule("""(?i)\b(rm|del|format|shutdown|reboot)\b""".toRegex(), Action.DENY),
        Rule(""".*(>|>>|\|).*""".toRegex(), Action.ASK),
        Rule("""^curl( |$)|^wget( |$)""".toRegex(), Action.ASK),
    )
}
