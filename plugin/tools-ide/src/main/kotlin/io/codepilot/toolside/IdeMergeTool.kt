package io.codepilot.toolside

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import io.codepilot.harness.tool.builtin.MergeTool
import java.nio.file.Path

/**
 * IDE-backed three-way merge.
 *
 * Delegates the merge algorithm to the pure-JVM [MergeTool]; when the merge
 * yields conflicts, notifies the user (a full IntelliJ merge-dialog integration
 * is a TODO for M3 — for now we report the conflict regions so the agent can
 * surface them). Conflict-free merges are returned with the merged text.
 *
 * The original `plugin/tools/ThreeWayMerger.kt` is a god-class with IDE
 * plumbing baked into the algorithm; here the algorithm is sunk into
 * harness-core and this class is a thin UI shell.
 */
class IdeMergeTool(
    private val project: Project,
    @Suppress("unused") private val workspaceRoot: Path,
) {
    private val engine = MergeTool()

    data class MergeOutcome(
        val mergedText: String,
        val hadConflicts: Boolean,
        val conflicts: List<MergeTool.ConflictRegion>,
        val autoResolved: Int,
    )

    /**
     * Merges [ours] and [theirs] against [base].
     * Returns the merged text; if conflicts remain, reports them to the user
     * via a notification (interactive merge dialog is a TODO).
     */
    fun merge(base: String, ours: String, theirs: String, relativePath: String): MergeOutcome {
        val result = engine.merge(base, ours, theirs)
        if (!result.hasConflicts) {
            return MergeOutcome(result.merged, false, emptyList(), result.autoResolvedCount)
        }
        // Notify the user that conflicts exist; a full merge-dialog integration
        // is deferred to M3.
        val app = ApplicationManager.getApplication()
        app.invokeLater {
            Messages.showWarningDialog(
                project,
                "${result.conflicts.size} conflict region(s) in $relativePath " +
                    "(${result.autoResolvedCount} auto-resolved). " +
                    "Manual resolution UI is a TODO; merged text with markers returned.",
                "CodePilot · merge conflicts",
            )
        }
        return MergeOutcome(result.merged, true, result.conflicts, result.autoResolvedCount)
    }
}
