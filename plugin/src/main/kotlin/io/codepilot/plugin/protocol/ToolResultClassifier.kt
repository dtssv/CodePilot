package io.codepilot.plugin.protocol

import com.fasterxml.jackson.databind.JsonNode

/**
 * Maps the raw `result: Any?` produced by [io.codepilot.plugin.tools.ToolDispatcher]
 * (typically a `Map<String, Any?>`) into a v2 [EventTypes.TOOL_RESULT] payload
 * with an explicit `kind` discriminator and a stable shape.
 *
 * Why a classifier instead of changing ToolDispatcher:
 *  - The legacy result shape is consumed by the backend (ToolResultBus / LLM
 *    tool feedback). Changing it server-bound would break the model contract.
 *  - This classifier produces a *parallel* representation for the WebUI only.
 *  - Adding a new tool? Add a `when` branch + a UI renderer; no other code path
 *    needs to change.
 *
 * See doc/02-tool-call-card.md for the rendered component matrix.
 */
object ToolResultClassifier {
    /**
     * @param toolName the model-facing tool name (e.g. "fs.read", "mcp.github.list_issues")
     * @param args     the original tool arguments (used to recover command/cwd for shell etc.)
     * @param ok       whether the tool reported success
     * @param result   the raw result payload (may be Map / List / primitive / null)
     * @param errorCode optional structured error code (ToolDispatcher emits e.g. "path_violation")
     * @param errorMessage optional human-readable error message
     */
    fun classify(
        toolName: String,
        args: JsonNode?,
        ok: Boolean,
        result: Any?,
        errorCode: String? = null,
        errorMessage: String? = null,
    ): Map<String, Any?> {
        if (!ok) {
            return mapOf(
                "kind" to "error",
                "tool" to toolName,
                "errorCode" to errorCode,
                "errorMessage" to (errorMessage ?: "Tool failed"),
                "raw" to result,
            )
        }

        @Suppress("UNCHECKED_CAST")
        val m = (result as? Map<String, Any?>) ?: return mapOf(
            "kind" to "unknown",
            "tool" to toolName,
            "raw" to result,
        )

        return when {
            toolName == "fs.read" && m["isDirectory"] == true -> mapOf(
                "kind" to "fs.list",
                "path" to m["path"],
                "entries" to (m["entries"] ?: emptyList<Any>()),
            )
            toolName == "fs.read" || toolName == "fs.outline" -> mapOf(
                "kind" to "fs.read",
                "path" to m["path"],
                "lang" to m["lang"],
                "totalLines" to m["totalLines"],
                "bytes" to m["bytes"],
                "truncated" to (m["truncated"] ?: false),
                "content" to (m["content"] ?: ""),
                "range" to extractReadRange(args),
            )
            toolName == "fs.list" -> mapOf(
                "kind" to "fs.list",
                "path" to (m["path"] ?: args?.path("path")?.asText()),
                "entries" to (m["entries"] ?: emptyList<Any>()),
            )
            toolName == "fs.grep" || toolName == "fs.search" -> {
                val hits = (m["hits"] as? List<*>)?.mapNotNull { hit ->
                    @Suppress("UNCHECKED_CAST")
                    val h = hit as? Map<String, Any?> ?: return@mapNotNull null
                    mapOf(
                        "path" to h["path"],
                        "line" to h["line"],
                        "preview" to (h["matchLine"] ?: h["preview"] ?: ""),
                        "context" to h["context"],
                    )
                } ?: emptyList()
                val total = (m["totalHits"] as? Int) ?: hits.size
                mapOf(
                    "kind" to "grep",
                    "pattern" to (m["pattern"] ?: args?.path("pattern")?.asText("")),
                    "matches" to hits,
                    "total" to total,
                    "truncated" to (total > hits.size),
                )
            }
            toolName == "shell.exec" || toolName == "shell.session" -> mapOf(
                "kind" to "shell",
                "command" to (args?.path("command")?.asText() ?: m["command"] ?: ""),
                "cwd" to (m["cwd"] ?: args?.path("cwd")?.asText("")),
                "exitCode" to (m["exitCode"] ?: -1),
                "stdout" to (m["stdout"] ?: ""),
                "stderr" to (m["stderr"] ?: ""),
                "durationMs" to (m["durationMs"] ?: 0),
                "timedOut" to (m["timedOut"] ?: false),
                "os" to m["os"],
            )
            // Write-class tools: route through PatchApplier. We only know which
            // file was touched; the unified diff is held by PatchRecorder/PatchStaging
            // and can be requested separately by the UI via `apply.*` endpoints
            // (see doc/03-apply-workflow.md).
            toolName == "fs.write" || toolName == "fs.replace" ||
                toolName == "fs.delete" || toolName == "fs.move" ||
                toolName == "fs.applyPatch" || toolName == "fs.create" -> mapOf(
                "kind" to "fs.write",
                "op" to (m["originalOp"] ?: toolName.removePrefix("fs.")),
                "path" to (m["path"] ?: args?.path("path")?.asText("")),
                "appliedVia" to m["appliedVia"],
                "routedAs" to m["routedAs"],
            )
            toolName == "ide.openFile" -> mapOf(
                "kind" to "ide.openFile",
                "path" to (m["opened"] ?: ""),
                "line" to m["line"],
            )
            toolName == "ide.diagnostics" -> mapOf(
                "kind" to "ide.diagnostics",
                "path" to (m["path"] ?: args?.path("path")?.asText("")),
                "diagnostics" to (m["diagnostics"] ?: emptyList<Any>()),
            )
            toolName == "ide.shadowValidate" -> mapOf(
                "kind" to "ide.shadowValidate",
                "passed" to (m["passed"] ?: false),
                "errors" to (m["errors"] ?: emptyList<Any>()),
                "durationMs" to (m["durationMs"] ?: 0),
            )
            toolName == "code.outline" -> mapOf(
                "kind" to "code.outline",
                "path" to (m["path"] ?: args?.path("path")?.asText("")),
                "outline" to (m["outline"] ?: emptyList<Any>()),
            )
            toolName.startsWith("mcp.") -> {
                // Split "mcp.<server>.<tool>" once on the rightmost dot for the tool slug.
                val parts = toolName.removePrefix("mcp.").split('.', limit = 2)
                mapOf(
                    "kind" to "mcp",
                    "server" to (parts.getOrNull(0) ?: ""),
                    "tool" to (parts.getOrNull(1) ?: ""),
                    "content" to m,
                )
            }
            toolName.startsWith("notepad.") -> mapOf(
                "kind" to "notepad",
                "op" to toolName.removePrefix("notepad."),
                "content" to m,
            )
            else -> mapOf("kind" to "unknown", "tool" to toolName, "raw" to m)
        }
    }

    private fun extractReadRange(args: JsonNode?): Map<String, Any?>? {
        if (args == null || args.isMissingNode) return null
        val rng = args.path("range")
        if (rng.isMissingNode) return null
        val s = rng.path("startLine").asInt(0).takeIf { it > 0 }
        val e = rng.path("endLine").asInt(0).takeIf { it > 0 }
        if (s == null && e == null) return null
        return mapOf("startLine" to s, "endLine" to e)
    }
}
