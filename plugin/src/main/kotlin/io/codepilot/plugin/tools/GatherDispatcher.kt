package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import io.codepilot.plugin.conversation.ConversationClient

/**
 * Client-side executor for Gather node info requests.
 *
 * When the Graph Orchestrator emits a `graph_info_request` SSE event, the plugin
 * routes client-executable requests (fs.read, fs.list, fs.grep, code.outline,
 * code.symbol, code.usages, shell.exec[readOnly]) through this dispatcher.
 *
 * Each request is executed in a pooled thread, results are collected and batch-sent
 * back to the backend via [ConversationClient.submitToolResult].
 *
 * Key constraints:
 *   - ALL operations are read-only; write attempts throw [ToolViolation]
 *   - shell.exec enforced by [ReadOnlyShellGuard]
 *   - Results are truncated per maxBytes and reported with sha1 for cache
 */
class GatherDispatcher(
    private val project: Project,
    private val client: ConversationClient,
    private val sessionId: String,
) {
    private val log = Logger.getInstance(GatherDispatcher::class.java)
    private val mapper = ObjectMapper()
    private val fileReader = FileReader(project)
    private val codeInspector = CodeInspector(project)
    private val grepTool = GrepSearchTool(project)
    private val shellExecutor = ShellExecutor(project)

    /**
     * Dispatches a batch of info requests from a graph_info_request event.
     * Each request is executed individually; failures do not block other requests.
     *
     * @param toolCallId the tool call ID from the SSE event, used to correlate
     *                   the result back to the backend's ToolResultBus subscription
     */
    fun dispatchBatch(requests: JsonNode, toolCallId: String = "gather-batch") {
        if (!requests.isArray) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val results = mutableListOf<Map<String, Any?>>()
            for (req in requests) {
                val id = req.path("id").asText()
                val kind = req.path("kind").asText()
                val args = req.path("args")
                val startMs = System.currentTimeMillis()
                try {
                    val result = dispatchSingle(kind, args)
                    results.add(
                        mapOf(
                            "id" to id,
                            "kind" to kind,
                            "ok" to true,
                            "result" to result,
                            "durationMs" to (System.currentTimeMillis() - startMs),
                        ),
                    )
                } catch (v: ToolViolation) {
                    log.warn("Gather request $id ($kind) blocked: ${v.message}")
                    results.add(
                        mapOf(
                            "id" to id,
                            "kind" to kind,
                            "ok" to false,
                            "errorCode" to "gather_write_blocked",
                            "errorMessage" to v.message,
                            "durationMs" to (System.currentTimeMillis() - startMs),
                        ),
                    )
                } catch (t: Throwable) {
                    log.warn("Gather request $id ($kind) failed", t)
                    results.add(
                        mapOf(
                            "id" to id,
                            "kind" to kind,
                            "ok" to false,
                            "errorCode" to "gather_error",
                            "errorMessage" to (t.message ?: t.javaClass.simpleName),
                            "durationMs" to (System.currentTimeMillis() - startMs),
                        ),
                    )
                }
            }
            // Submit all results back as a single batch tool-result
            // Use the toolCallId from the SSE event so the backend's
            // ToolResultBus subscription can match it
            client.submitToolResult(
                mapOf(
                    "sessionId" to sessionId,
                    "toolCallId" to toolCallId,
                    "ok" to results.all { it["ok"] == true },
                    "result" to mapOf("gathered" to results),
                ),
            )
        }
    }

    private fun dispatchSingle(
        kind: String,
        args: JsonNode,
    ): Map<String, Any?> =
        when (kind) {
            "fs.read" -> fileReader.read(args)
            "fs.list" -> {
                val path = args.path("path").asText(".")
                val vf = PathGuard.resolve(project, path)
                if (!vf.isDirectory) throw ToolViolation("not a directory: $path")
                val entries =
                    vf.children.take(500).map { f ->
                        mapOf(
                            "name" to f.name,
                            "type" to if (f.isDirectory) "dir" else "file",
                            "size" to f.length,
                        )
                    }
                mapOf("path" to path, "entries" to entries)
            }
            "fs.grep" -> grepTool.grep(args)
            "code.outline" -> codeInspector.outline(args)
            "code.symbol" -> codeInspector.findSymbol(args)
            "code.usages" -> codeInspector.findUsages(args)
            "shell.exec" -> {
                ReadOnlyShellGuard.validate(args)
                shellExecutor.execute(args)
            }
            else -> throw ToolViolation("unsupported gather kind: $kind (only client-side tools)")
        }
}
