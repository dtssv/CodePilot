package io.codepilot.adapter

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.perm.PermissionGate
import io.codepilot.harness.perm.Verdict
import io.codepilot.harness.tool.ToolCatalog

/**
 * IntelliJ-based approval handler for the harness-core [PermissionGate].
 *
 * When the gate returns [Verdict.Ask], this adapter pops a modal
 * [Messages.showOkCancelDialog] on the EDT and translates the result back to
 * an allow/deny verdict. Safe-by-default: a closed/cancelled dialog denies.
 *
 * The gate itself stays pure-JVM; this is the only piece that knows about
 * Swing/IntelliJ UI.
 */
class DialogApprovalHandler(private val project: Project) {

    /**
     * Resolves an [Verdict.Ask] verdict by asking the user.
     * Non-Ask verdicts are returned unchanged.
     */
    fun resolve(verdict: Verdict, call: ToolCallSpec): Verdict {
        if (verdict !is Verdict.Ask) return verdict
        val title = "CodePilot · tool approval"
        val msg = buildString {
            appendLine("Tool:    ").append(call.name)
            appendLine("Call ID: ").append(call.id)
            appendLine()
            append("Reason:  ").append(verdict.reason)
        }
        val rc = Messages.showOkCancelDialog(
            project,
            msg,
            title,
            "Allow",
            "Deny",
            com.intellij.openapi.ui.Messages.getQuestionIcon(),
        )
        return if (rc == Messages.OK) Verdict.Allow else Verdict.Deny("user denied in dialog")
    }

    /**
     * Convenience: gate + ask in one call.
     */
    fun checkAndAsk(
        gate: PermissionGate,
        call: ToolCallSpec,
        catalog: ToolCatalog,
        argsJson: String? = null,
    ): Verdict = resolve(gate.check(call, catalog, argsJson), call)
}
