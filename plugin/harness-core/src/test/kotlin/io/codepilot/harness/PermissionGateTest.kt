package io.codepilot.harness

import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.perm.Mode
import io.codepilot.harness.perm.PermissionGate
import io.codepilot.harness.perm.PermissionRule
import io.codepilot.harness.perm.Verdict
import io.codepilot.harness.tool.ToolCatalog
import io.codepilot.harness.tool.WorkspaceScope
import io.codepilot.harness.tool.builtin.defaultFsCatalog
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class PermissionGateTest {

    @TempDir
    lateinit var ws: Path

    private fun gate(rules: List<PermissionRule>): Pair<PermissionGate, ToolCatalog> {
        val catalog = ToolCatalog(defaultFsCatalog(WorkspaceScope(ws)))
        return PermissionGate(rules) to catalog
    }

    @Test
    fun `safe tools allowed by default rules`() {
        val (gate, cat) = gate(PermissionGate.defaultRules())
        val v = gate.check(ToolCallSpec("1", "read_file", "{}"), cat)
        assertTrue(v is Verdict.Allow)
    }

    @Test
    fun `unknown tool denied`() {
        val (gate, cat) = gate(emptyList())
        val v = gate.check(ToolCallSpec("1", "rm_rf", "{}"), cat)
        assertTrue(v is Verdict.Deny)
    }

    @Test
    fun `unmatched write tool falls back to ask`() {
        val (gate, cat) = gate(listOf(PermissionRule(Regex("grep"), Mode.ALLOW)))
        val v = gate.check(ToolCallSpec("1", "edit_file", "{}"), cat)
        assertTrue(v is Verdict.Ask)
    }

    @Test
    fun `explicit deny wins over allow`() {
        val (gate, cat) = gate(
            listOf(
                PermissionRule(Regex("edit_.*"), Mode.DENY, reason = "frozen repo"),
                PermissionRule(Regex(".*"), Mode.ALLOW),
            )
        )
        val v = gate.check(ToolCallSpec("1", "edit_file", "{}"), cat)
        assertTrue(v is Verdict.Deny && v.reason.contains("frozen"))
    }
}
