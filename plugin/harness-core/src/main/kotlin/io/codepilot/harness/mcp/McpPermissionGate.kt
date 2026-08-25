package io.codepilot.harness.mcp

import io.codepilot.harness.model.AssistantToolCall
import io.codepilot.harness.model.ToolCallSpec
import io.codepilot.harness.perm.PermissionGate
import io.codepilot.harness.perm.Verdict
import io.codepilot.harness.tool.ToolCatalog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * Permission gate for MCP tool calls.
 *
 * MCP tools are external — they can run arbitrary code in a subprocess or on a
 * remote server — so we want a human-in-the-loop approval step the first time
 * a given (serverId, toolName) is invoked. The harness loop's existing
 * [PermissionGate] already handles allow/deny/ask; this class adds a
 * [suspend] approval callback for the Ask path so the IDE adapter can pop up
 * a dialog and resolve the deferred.
 *
 * Usage:
 *   - The harness loop calls [check] before executing any mcp.* tool.
 *   - On first invocation, [check] returns [Verdict.Ask] with a callback.
 *   - The IDE adapter registers a [ApprovalHandler] which shows a dialog and
 *     calls [resolve].
 *   - The harness loop's ApprovalHandler then proceeds.
 *
 * "Remember allow" semantics: once a (serverId, toolName) is approved,
 * subsequent calls return [Verdict.Allow] for the session. Denials are not
 * remembered (the user may change their mind).
 */
class McpPermissionGate(
    private val underlying: PermissionGate,
) {
    private val approved = mutableSetOf<Pair<String, String>>()
    private val denied = mutableSetOf<Pair<String, String>>()

    /**
     * Check an MCP tool call. Returns the verdict; for Ask verdicts, the
     * harness loop should hand the [ApprovalRequest] to its ApprovalHandler.
     */
    fun check(spec: ToolCallSpec, catalog: ToolCatalog): McpVerdict {
        // First defer to the underlying PermissionGate (which may have a
        // rule-based default for the mcp.* namespace).
        when (val base = underlying.check(spec, catalog)) {
            is Verdict.Allow -> return McpVerdict.Allow
            is Verdict.Deny -> return McpVerdict.Deny(base.reason)
            is Verdict.Ask -> { /* fall through to MCP-specific logic */ }
        }
        val parts = spec.name.split(".", limit = 3)
        if (parts.size < 3) return McpVerdict.Allow
        val serverId = parts[1]; val toolName = parts[2]
        val key = serverId to toolName
        if (key in approved) return McpVerdict.Allow
        if (key in denied) return McpVerdict.Deny("previously denied")
        return McpVerdict.Ask(ApprovalRequest(serverId, toolName, spec.id) { granted ->
            if (granted) approved.add(key) else denied.add(key)
        })
    }

    /** Verdict for an MCP tool call. */
    sealed interface McpVerdict {
        data object Allow : McpVerdict
        data class Deny(val reason: String) : McpVerdict
        data class Ask(val request: ApprovalRequest) : McpVerdict
    }

    /**
     * An approval request: the IDE adapter should ask the user whether to
     * allow [serverId].[toolName], then call [resolver] with the answer.
     */
    data class ApprovalRequest(
        val serverId: String,
        val toolName: String,
        val callId: String,
        val resolver: (Boolean) -> Unit,
    )

    /**
     * Suspend variant: block until the [ApprovalRequest] is resolved.
     * Useful for harness loops that prefer a suspend callback over a Java
     * callback.
     */
    suspend fun checkSuspend(spec: ToolCallSpec, catalog: ToolCatalog, approvalHandler: suspend (ApprovalRequest) -> Boolean): McpVerdict {
        val v = check(spec, catalog)
        if (v !is McpVerdict.Ask) return v
        val granted = approvalHandler(v.request)
        v.request.resolver(granted)
        return if (granted) McpVerdict.Allow else McpVerdict.Deny("user denied")
    }
}
