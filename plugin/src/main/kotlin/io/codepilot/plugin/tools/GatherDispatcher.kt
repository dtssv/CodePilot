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
    private val onGatherResult: ((toolCallId: String, ok: Boolean, httpResponse: String?) -> Unit)? = null,
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
                    // Run file operations in Read Action for IntelliJ VFS access
                    val result = ApplicationManager.getApplication().runReadAction<Map<String, Any?>> {
                        dispatchSingle(kind, args)
                    }
                    val ok =
                        if (kind == "shell.exec") {
                            ShellWorkingDirectory.isSuccess(result)
                        } else {
                            true
                        }
                    results.add(
                        mapOf(
                            "id" to id,
                            "kind" to kind,
                            "ok" to ok,
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
            val allOk = results.all { it["ok"] == true }
            var httpResponse: String? = null
            try {
                httpResponse = client.submitToolResultSync(
                    sessionId = sessionId,
                    toolCallId = toolCallId,
                    result = mapOf("gathered" to results),
                    ok = allOk,
                )
                log.info("GatherDispatcher: submitted tool result for toolCallId=$toolCallId, ok=$allOk, response=$httpResponse")
            } catch (e: Exception) {
                log.error("GatherDispatcher: FAILED to submit tool result for toolCallId=$toolCallId", e)
                httpResponse = "ERROR: ${e.message}"
            }
            // Notify UI that gather.execute completed
            onGatherResult?.invoke(toolCallId, allOk, httpResponse)
        }
    }

    private fun dispatchSingle(
        kind: String,
        args: JsonNode,
    ): Map<String, Any?> =
        when (kind) {
            "fs.read" -> {
                val path = args.path("path").asText("")
                val vf = PathGuard.resolve(project, path)
                if (vf.isDirectory) {
                    // When reading a directory, read the first file in it instead
                    val firstFile = vf.children.firstOrNull { !it.isDirectory }
                    if (firstFile != null) {
                        fileReader.read(mapper.readTree("{\"path\":\"${firstFile.path}\"}"))
                    } else {
                        throw ToolViolation("directory has no files: $path")
                    }
                } else {
                    fileReader.read(args)
                }
            }
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
