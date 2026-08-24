package io.codepilot.harness.perm

import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.tool.DangerLevel
import io.codepilot.harness.tool.ToolCatalog
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive

sealed interface Verdict {
    data object Allow : Verdict
    data class Ask(val reason: String) : Verdict
    data class Deny(val reason: String) : Verdict
}

enum class Mode { ALLOW, ASK, DENY }

data class PermissionRule(
    val toolPattern: Regex,
    val mode: Mode,
    val reason: String = "",
)

class PermissionGate(private val rules: List<PermissionRule>) {

    /** First matching rule wins; unmatched tools default to ASK (safe by default). */
    fun check(call: ToolCallSpec, catalog: ToolCatalog, argsJson: String? = null): Verdict {
        val tool = catalog.get(call.name)
            ?: return Verdict.Deny("unknown tool: ${call.name}")
        for (rule in rules) {
            if (!rule.toolPattern.matches(call.name)) continue
            return when (rule.mode) {
                Mode.ALLOW -> refineByDanger(tool.spec.dangerLevel, call, argsJson) ?: Verdict.Allow
                Mode.ASK -> Verdict.Ask(rule.reason.ifEmpty { "tool ${call.name} requires approval" })
                Mode.DENY -> Verdict.Deny(rule.reason.ifEmpty { "tool ${call.name} is denied by policy" })
            }
        }
        return when (tool.spec.dangerLevel) {
            DangerLevel.SAFE -> Verdict.Allow
            else -> Verdict.Ask("unclassified write/exec tool: ${call.name}")
        }
    }

    private fun refineByDanger(level: DangerLevel, call: ToolCallSpec, argsJson: String?): Verdict? =
        when (level) {
            DangerLevel.SAFE -> null
            DangerLevel.WRITE -> null
            DangerLevel.EXEC -> Verdict.Ask("exec tool requires approval")
        }

    companion object {
        private val json = Json

        fun defaultRules(): List<PermissionRule> = listOf(
            PermissionRule(Regex("read_file|list_dir|grep"), Mode.ALLOW),
            PermissionRule(Regex("write_file|edit_file"), Mode.ALLOW, reason = "workspace writes are allowed by default"),
            PermissionRule(Regex("run_command"), Mode.ASK, reason = "shell commands require approval"),
            PermissionRule(Regex("rm_rf|dangerous_.*"), Mode.DENY, reason = "destructive tools denied"),
        )
    }
}
