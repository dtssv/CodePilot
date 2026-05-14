package io.codepilot.plugin.tools

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtil
import io.codepilot.plugin.conversation.ConversationClient
import io.codepilot.plugin.marketplace.LocalMarketplaceStore
import io.codepilot.plugin.mcp.McpProcessManager
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicLong

/**
 * Routes a model-issued `tool_call` to a real client-side handler. Supports:
 * - Built-in read tools (fs.read, fs.list, fs.search, fs.outline)
 * - fs.create (creates files)
 * - fs.write / fs.replace / fs.delete / fs.move → routed through [PatchApplier]
 * - shell.exec
 * - ide.openFile / ide.diagnostics / ide.applyPatch
 * - mcp.<server>.<tool> → routed to [McpProcessManager]
 */
class ToolDispatcher(
    private val project: Project,
    private val client: ConversationClient,
    private val sessionId: String,
    private val graphStateStore: GraphStateStore? = null,
    /** Optional callback invoked after each tool execution completes, for UI feedback. */
    private val onToolResult: ((toolCallId: String, ok: Boolean, result: Any?) -> Unit)? = null,
) {
    private val log = com.intellij.openapi.diagnostic.Logger.getInstance(ToolDispatcher::class.java)
    private val patchApplier = PatchApplier(project)
    private val fileReader = FileReader(project)
    private val codeInspector = CodeInspector(project)
    private val grepTool = GrepSearchTool(project)

    // ─── Tool Result Cache ─────────────────────────────────────────────
    // Caches read-only tool results to avoid redundant file reads and searches
    private val toolResultCache = java.util.concurrent.ConcurrentHashMap<String, CachedToolResult>()
    private val CACHE_TTL_MS = 30_000L // 30 seconds TTL for tool results

    data class CachedToolResult(
        val result: Any?,
        val timestamp: Long = System.currentTimeMillis(),
    ) {
        fun isExpired(): Boolean = System.currentTimeMillis() - timestamp > 30_000L
    }

    // ─── Parallel Dispatch ─────────────────────────────────────────────
    /**
     * Dispatch multiple independent tool calls in parallel.
     * Read-only tools (fs.read, fs.list, fs.search, fs.grep, fs.outline, code.*, ide.diagnostics)
     * can be safely parallelized. Write tools are always sequential.
     */
    fun dispatchParallel(toolCalls: List<JsonNode>) {
        val (readOnly, writeOps) = toolCalls.partition { isReadOnlyTool(it.path("name").asText()) }

        // Execute read-only tools in parallel
        readOnly.map { call ->
            java.util.concurrent.CompletableFuture.runAsync {
                dispatch(call)
            }
        }.forEach { it.join() }

        // Execute write operations sequentially
        writeOps.forEach { dispatch(it) }
    }

    private fun isReadOnlyTool(name: String): Boolean = when {
        name.startsWith("fs.read") || name.startsWith("fs.list") || name.startsWith("fs.search") -> true
        name.startsWith("fs.grep") || name.startsWith("fs.outline") -> true
        name.startsWith("code.") -> true
        name.startsWith("ide.diagnostics") || name.startsWith("ide.openFile") -> true
        name.startsWith("ide.shadowValidate") -> true
        else -> false
    }

    fun dispatch(toolCall: JsonNode) {
        val name = toolCall.path("name").asText()
        val id = toolCall.path("id").asText()
        val args = toolCall.path("args")

        // Skip gather.execute tool calls — they are handled by GatherDispatcher
        // via the graph_info_request SSE event, not by ToolDispatcher.
        // Without this, ToolDispatcher would refuse the tool and send a failure
        // result back to the backend's ToolResultBus, competing with the
        // GatherDispatcher's correct result.
        if (name == "gather.execute") {
            log.info("ToolDispatcher: skipping gather.execute tool_call (handled by GatherDispatcher)")
            return
        }

        // Check cache for read-only tools
        if (isReadOnlyTool(name)) {
            val cacheKey = buildCacheKey(name, args)
            val cached = toolResultCache[cacheKey]
            if (cached != null && !cached.isExpired()) {
                respond(id, true, cached.result, null, null, System.nanoTime())
                return
            }
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            val started = System.nanoTime()
            try {
                val result =
                    when {
                        name == "fs.read" -> fileReader.read(args)
                        name == "fs.list" -> listDir(args)
                        name == "fs.search" -> searchProject(args)
                        name == "fs.grep" -> grepTool.grep(args)
                        name == "fs.outline" -> fileOutline(args)
                        name == "code.outline" -> codeInspector.outline(args)
                        name == "code.symbol" -> codeInspector.findSymbol(args)
                        name == "code.usages" -> codeInspector.findUsages(args)
                        name == "fs.create" -> createFile(args)
                        name == "fs.write" -> dispatchViaPatchApplier(name, args)
                        name == "fs.replace" -> dispatchViaPatchApplier(name, args)
                        name == "fs.delete" -> dispatchViaPatchApplier(name, args)
                        name == "fs.move" -> dispatchViaPatchApplier(name, args)
                        name == "fs.applyPatch" -> dispatchApplyPatch(args)
                        name == "shell.exec" -> ShellExecutor(project).execute(args)
                        name == "shell.session" -> dispatchShellSession(args)
                        name == "plan.show" -> planShow(args)
                        name == "plan.update" -> planUpdate(args)
                        name == "ide.openFile" -> ideOpenFile(args)
                        name == "ide.diagnostics" -> ideDiagnostics(args)
                        name == "ide.applyPatch" -> ideApplyPatch(args)
                        name == "ide.shadowValidate" -> ideShadowValidate(args)
                        // ★ Integration: NotepadService for Agent working memory
                        name == "notepad.write" -> notepadWrite(args)
                        name == "notepad.read" -> notepadRead(args)
                        name.startsWith("mcp.") -> dispatchMcp(name, args)
                        else -> return@executeOnPooledThread refuse(id, "unsupported tool: $name", started)
                    }

                // Cache read-only tool results
                if (isReadOnlyTool(name)) {
                    val cacheKey = buildCacheKey(name, args)
                    toolResultCache[cacheKey] = CachedToolResult(result)
                }

                respond(id, true, result, null, null, started)
            } catch (v: ToolViolation) {
                respond(id, false, null, "path_violation", v.message, started)
            } catch (t: Throwable) {
                respond(id, false, null, "tool_error", t.message ?: t.javaClass.simpleName, started)
            }
        }
    }

    /** Convenience overload for direct dispatch from CefChatPanel. */
    fun dispatch(
        toolName: String,
        toolArgs: Any?,
        toolCallId: String,
    ) {
        val mapper =
            com.fasterxml.jackson.databind
                .ObjectMapper()
        val node = mapper.createObjectNode()
        node.put("name", toolName)
        node.put("id", toolCallId)
        node.set<JsonNode>("args", mapper.valueToTree(toolArgs ?: emptyMap<String, Any>()))
        dispatch(node)
    }

    /**
     * Initialize MCP servers from the installed list. Called once at session start.
     * Returns the combined tools/list from all started servers.
     */
    fun initMcpServers(): List<Map<String, Any>> {
        val store = LocalMarketplaceStore.getInstance()
        val installed = store.installedMcpServers()
        val mcpManager = McpProcessManager.getInstance()
        val allTools = mutableListOf<Map<String, Any>>()

        for (server in installed) {
            try {
                if (!mcpManager.isRunning(server.id)) {
                    when (server.transport) {
                        LocalMarketplaceStore.McpTransport.STDIO -> {
                            mcpManager.start(
                                server.id,
                                McpProcessManager.McpLaunchSpec(
                                    id = server.id,
                                    argv = server.argv,
                                    cwd = server.cwd,
                                    env = server.env,
                                ),
                            )
                        }
                        LocalMarketplaceStore.McpTransport.SSE,
                        LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP,
                        -> {
                            val url = server.url
                                ?: throw IllegalStateException("Missing URL for remote MCP server '${server.id}'")
                            mcpManager.startRemote(server.id, url, server.transport, server.headers)
                        }
                    }
                }
                // Fetch tools/list from the running server
                val toolsResult = mcpManager.call(server.id, "tools/list", null)
                if (toolsResult.isArray) {
                    toolsResult.forEach { tool ->
                        allTools.add(
                            mapOf(
                                "name" to "mcp.${server.id}.${tool.path("name").asText()}",
                                "description" to tool.path("description").asText(""),
                                "parameters" to tool.path("inputSchema"),
                            ),
                        )
                    }
                }
            } catch (e: Exception) {
                com.intellij.openapi.diagnostic.Logger
                    .getInstance("ToolDispatcher")
                    .warn("Failed to start MCP server ${server.id}", e)
            }
        }
        return allTools
    }

    // ---------- MCP routing ----------

    private fun dispatchShellSession(args: JsonNode): Map<String, Any?> {
        val sessionManager = TerminalSessionManager.getInstance(project)
        val action = args.path("action").asText("exec")
        return when (action) {
            "exec" -> {
                val command = args.path("command").asText()
                if (command.isBlank()) throw ToolViolation("shell.session: missing command")
                val sessionId = args.path("sessionId").asText(null)
                val cwd = args.path("cwd").asText(null)
                val timeoutMs = args.path("timeoutMs").asLong(60_000)
                val result = sessionManager.execute(command, sessionId, cwd, timeoutMs)
                mapOf(
                    "stdout" to result.stdout,
                    "exitCode" to result.exitCode,
                    "durationMs" to result.durationMs,
                    "sessionId" to result.sessionId,
                )
            }
            "getOutput" -> {
                val sid = args.path("sessionId").asText()
                if (sid.isBlank()) throw ToolViolation("shell.session: missing sessionId for getOutput")
                val maxChars = args.path("maxChars").asInt(5000)
                val output = sessionManager.getRecentOutput(sid, maxChars)
                mapOf("output" to (output ?: ""), "sessionId" to sid)
            }
            "close" -> {
                val sid = args.path("sessionId").asText()
                if (sid.isBlank()) throw ToolViolation("shell.session: missing sessionId for close")
                sessionManager.closeSession(sid)
                mapOf("closed" to true, "sessionId" to sid)
            }
            else -> throw ToolViolation("shell.session: unknown action '$action'")
        }
    }

    // ---------- MCP routing (original) ----------

    // ★ Integration: NotepadService for Agent working memory
    private val notepadService = NotepadService.getInstance(project)

    private fun notepadWrite(args: JsonNode): Map<String, Any?> {
        val name = args.path("name").asText("default")
        val content = args.path("content").asText("")
        val entry = notepadService.write(sessionId, name, content)
        return mapOf("id" to entry.id, "name" to entry.name, "updatedAt" to entry.updatedAt)
    }

    private fun notepadRead(args: JsonNode): Map<String, Any?> {
        val name = args.path("name").asText("default")
        val entry = notepadService.read(sessionId, name)
        return if (entry != null) {
            mapOf("id" to entry.id, "name" to entry.name, "content" to entry.content, "updatedAt" to entry.updatedAt)
        } else {
            mapOf("error" to "Notepad '$name' not found")
        }
    }

    private fun dispatchMcp(
        fullName: String,
        args: JsonNode,
    ): Map<String, Any?> {
        // Parse: mcp.<serverId>.<toolName>
        val parts = fullName.removePrefix("mcp.").split(".", limit = 2)
        if (parts.size < 2) throw ToolViolation("Invalid MCP tool name: $fullName")
        val serverId = parts[0]
        val toolName = parts[1]

        val mcpManager = McpProcessManager.getInstance()
        if (!mcpManager.isRunning(serverId)) {
            throw ToolViolation("MCP server not running: $serverId")
        }

        val result = mcpManager.call(serverId, "tools/call", mapOf("name" to toolName, "arguments" to args))
        return mapOf("mcpResult" to result.toString())
    }

    // ---------- PatchApplier routing ----------

    private fun dispatchViaPatchApplier(
        name: String,
        args: JsonNode,
    ): Map<String, Any?> {
        patchApplier.apply(name, args)
        return mapOf("ack" to true, "appliedVia" to "DiffManager")
    }

    /**
     * Dispatch fs.applyPatch tool calls.
     * The backend sends fs.applyPatch with args in two formats:
     * - Single edit: {path, op, search, replace, newContent}
     * - Multi-edit batch: {patches: [{path, op, search, replace, newContent}, ...]}
     * Routes each patch to PatchApplier with the appropriate tool name based on the op field.
     */
    private fun dispatchApplyPatch(args: JsonNode): Map<String, Any?> {
        // Check if this is a batch (patches array) or single-edit format
        val patchesNode = args.path("patches")
        if (!patchesNode.isMissingNode && patchesNode.isArray && patchesNode.size() > 0) {
            // Batch format: iterate over each patch in the array
            val results = mutableListOf<Map<String, Any?>>()
            for (patch in patchesNode) {
                val result = applySinglePatch(patch)
                results.add(result)
            }
            val appliedCount = results.count { it["ok"] == true }
            return mapOf(
                "ack" to true,
                "appliedVia" to "DiffManager",
                "batchSize" to patchesNode.size(),
                "appliedCount" to appliedCount,
                "results" to results,
            )
        }

        // Single-edit format: use args directly
        return applySinglePatch(args)
    }

    /**
     * Apply a single patch edit. Determines the effective tool name based on op
     * and routes to PatchApplier.
     */
    private fun applySinglePatch(patch: JsonNode): Map<String, Any?> {
        val op = patch.path("op").asText("replace")
        val hasSearchReplace = patch.has("search") && !patch.path("search").asText().isBlank()
        val hasNewContent = patch.has("newContent") && !patch.path("newContent").asText().isBlank()
        val path = patch.path("path").asText()

        // Determine the effective tool name based on op and available args
        val effectiveToolName = when {
            op == "create" -> "fs.create"
            op == "delete" -> "fs.delete"
            op == "replace" && hasSearchReplace -> "fs.replace"
            op == "replace" && hasNewContent && !hasSearchReplace -> "fs.write"
            hasNewContent -> "fs.write"
            else -> "fs.replace"
        }
        patchApplier.apply(effectiveToolName, patch)
        return mapOf("ok" to true, "path" to path, "appliedVia" to "DiffManager", "originalOp" to op, "routedAs" to effectiveToolName)
    }

    // ---------- IDE tools ----------

    private fun ideOpenFile(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val line = args.path("line").asInt(1)
        val vf = PathGuard.resolve(project, path)
        ApplicationManager.getApplication().invokeLater {
            com.intellij.openapi.fileEditor.FileEditorManager
                .getInstance(project)
                .openFile(vf, true)
            val editor =
                com.intellij.openapi.fileEditor.FileEditorManager
                    .getInstance(project)
                    .selectedTextEditor
            editor?.caretModel?.moveToLogicalPosition(
                com.intellij.openapi.editor
                    .LogicalPosition(line - 1, 0),
            )
        }
        return mapOf("opened" to path, "line" to line)
    }

    private fun ideDiagnostics(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val vf = PathGuard.resolve(project, path)
        val psiFile =
            com.intellij.psi.PsiManager
                .getInstance(project)
                .findFile(vf)
                ?: return mapOf("diagnostics" to emptyList<Any>())
        val diagnostics =
            com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
                .getInstanceEx(project)
                .let { analyzer ->
                    // Get highlights from the document
                    val doc =
                        com.intellij.openapi.fileEditor.FileDocumentManager
                            .getInstance()
                            .getDocument(vf) ?: return mapOf("diagnostics" to emptyList<Any>())
                    com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerImpl
                        .getHighlights(doc, null, project)
                        .map { h ->
                            mapOf(
                                "line" to doc.getLineNumber(h.startOffset) + 1,
                                "severity" to h.severity.name,
                                "message" to (h.description ?: ""),
                            )
                        }
                }
        return mapOf("path" to path, "diagnostics" to diagnostics)
    }

    /**
     * plan.show: Send plan data to the PlanPanel UI for display.
     * Also accepts userPlanEdits from the UI back to the backend.
     * Per 01-§6.1: "用户可在 Plan / Ledger 面板里勾选/编辑/暂停/追问"
     */
    private fun planShow(args: JsonNode): Map<String, Any?> {
        val planJson = args.path("plan").toString()
        val ledgerJson = args.path("ledger").toString()
        // Emit plan data to the UI via session event
        client.submitPlanData(sessionId, planJson, ledgerJson)
        return mapOf("ack" to true, "planDisplayed" to true)
    }

    /**
     * plan.update: User edits from PlanPanel → stored in GraphStateStore for next Agent turn.
     * Per 01-§6.1: "用户可在 Plan / Ledger 面板里勾选/编辑/暂停/追问"
     */
    private fun planUpdate(args: JsonNode): Map<String, Any?> {
        val edits = args.path("edits")
        val graphStateStore = graphStateStore ?: return mapOf("ok" to false, "error" to "no graphStateStore")
        graphStateStore.applyUserPlanEdits(edits)
        return mapOf("ok" to true, "editsStored" to true)
    }

    private fun ideApplyPatch(args: JsonNode): Map<String, Any?> {
        val patchText = args.path("patch").asText()
        patchApplier.applyUnifiedPatch(patchText)
        return mapOf("applied" to true)
    }

    /**
     * Shadow Workspace validation: applies patches in a temporary shadow copy,
     * runs compile/lint checks, and reports errors back without touching real files.
     * Per 01-§3.22: "Agent 写操作可选经 Shadow Workspace 先验证编译通过"
     */
    private fun ideShadowValidate(args: JsonNode): Map<String, Any?> {
        val patches = args.path("patches")
        if (patches.isMissingNode || !patches.isArray) {
            return mapOf("passed" to true, "errors" to emptyList<Any>())
        }

        val shadowWorkspace = ShadowWorkspace(project)
        val patchOps = mutableListOf<ShadowWorkspace.PatchOperation>()

        for (patch in patches) {
            val path = patch.path("path").asText()
            val op = patch.path("op").asText("replace")
            val content = patch.path("content").asText("")
            if (path.isNotBlank()) {
                patchOps.add(ShadowWorkspace.PatchOperation(path, op, content))
            }
        }

        val result = shadowWorkspace.validate(patchOps)
        return mapOf(
            "passed" to result.passed,
            "errors" to
                result.errors.map { e ->
                    mapOf("file" to e.file, "line" to e.line, "message" to e.message, "severity" to e.severity)
                },
            "durationMs" to result.durationMs,
        )
    }

    private fun refuse(
        toolCallId: String,
        reason: String,
        startedNs: Long,
    ) {
        respond(toolCallId, false, null, "unsupported", reason, startedNs)
    }

    private fun buildCacheKey(name: String, args: JsonNode): String {
        return "$name:${args.hashCode().toString(16)}"
    }

    private fun respond(
        toolCallId: String,
        ok: Boolean,
        result: Any?,
        errorCode: String?,
        errorMessage: String?,
        startedNs: Long,
    ) {
        val durationMs = (System.nanoTime() - startedNs) / 1_000_000
        // Notify UI callback about tool result for real-time status update
        onToolResult?.invoke(toolCallId, ok, result)
        client.submitToolResult(
            mutableMapOf<String, Any?>(
                "sessionId" to sessionId,
                "toolCallId" to toolCallId,
                "ok" to ok,
                "result" to result,
                "errorCode" to errorCode,
                "errorMessage" to errorMessage,
                "durationMs" to durationMs,
            ),
        )
    }

    // ---------- read tools ----------

    private fun readFile(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val maxBytes = args.path("maxBytes").asInt(262_144).coerceAtMost(1_048_576)
        val vf = PathGuard.resolve(project, path)
        if (vf.length > maxBytes) {
            throw ToolViolation("file too large: ${vf.length} > $maxBytes")
        }
        val text = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
        val (start, end) = readRange(args)
        val sliced = if (start != null && end != null) sliceLines(text, start, end) else text
        return mapOf(
            "path" to vf.path,
            "lang" to (vf.fileType.name),
            "size" to vf.length,
            "content" to sliced,
        )
    }

    private fun readRange(args: JsonNode): Pair<Int?, Int?> {
        val s =
            args
                .path("range")
                .path("startLine")
                .asInt(0)
                .takeIf { it > 0 }
        val e =
            args
                .path("range")
                .path("endLine")
                .asInt(0)
                .takeIf { it > 0 }
        return s to e
    }

    private fun sliceLines(
        text: String,
        start: Int,
        end: Int,
    ): String {
        val lines = text.lines()
        val from = (start - 1).coerceIn(0, lines.size)
        val to = end.coerceIn(from, lines.size)
        return lines.subList(from, to).joinToString("\n")
    }

    private fun listDir(args: JsonNode): Map<String, Any?> {
        val path = args.path("path").asText()
        val recursive = args.path("recursive").asBoolean(false)
        val vf = PathGuard.resolve(project, path)
        if (!vf.isDirectory) throw ToolViolation("not a directory: $path")
        val entries = mutableListOf<Map<String, Any?>>()
        VfsUtil.processFilesRecursively(vf) { f ->
            if (f != vf) {
                entries.add(
                    mapOf(
                        "path" to f.path.removePrefix(PathGuard.projectRoot(project).path).trimStart('/'),
                        "type" to if (f.isDirectory) "dir" else "file",
                        "size" to f.length,
                    ),
                )
            }
            recursive || f.parent == vf
        }
        return mapOf("entries" to entries.take(2_000))
    }

    private fun searchProject(args: JsonNode): Map<String, Any?> {
        val query = args.path("query").asText()
        if (query.isBlank()) throw ToolViolation("empty query")
        val regex = args.path("regex").asBoolean(false)
        val pattern = if (regex) Regex(query) else Regex(Regex.escape(query))
        val hits = mutableListOf<Map<String, Any?>>()
        val root = PathGuard.projectRoot(project)
        val limit = AtomicLong(50)
        VfsUtil.processFilesRecursively(root) { f ->
            if (limit.get() <= 0) return@processFilesRecursively false
            if (!f.isDirectory && f.length < 1_048_576) {
                val text =
                    runCatching { String(f.contentsToByteArray(), StandardCharsets.UTF_8) }
                        .getOrNull() ?: return@processFilesRecursively true
                pattern.findAll(text).take(5).forEach { m ->
                    if (limit.decrementAndGet() < 0) return@forEach
                    val before = text.substring(0, m.range.first).count { it == '\n' } + 1
                    hits.add(
                        mapOf(
                            "path" to f.path.removePrefix(root.path).trimStart('/'),
                            "line" to before,
                            "snippet" to m.value.take(120),
                        ),
                    )
                }
            }
            true
        }
        return mapOf("hits" to hits)
    }

    private fun fileOutline(args: JsonNode): Map<String, Any?> {
        val vf = PathGuard.resolve(project, args.path("path").asText())
        val text = String(vf.contentsToByteArray(), StandardCharsets.UTF_8)
        val firstLine = text.lineSequence().firstOrNull { it.isNotBlank() }
        return mapOf(
            "path" to vf.path,
            "lines" to text.count { it == '\n' } + 1,
            "firstNonEmptyLine" to (firstLine ?: ""),
        )
    }

    // ---------- mutating: fs.create only (others go through PatchApplier) ----------

    private fun createFile(args: JsonNode): Map<String, Any?> {
        val rel = args.path("path").asText()
        val content = args.path("content").asText("")
        val overwrite = args.path("overwrite").asBoolean(false)
        val target = PathGuard.resolveOrCreate(project, rel)
        if (Files.exists(target) && !overwrite) {
            throw ToolViolation("already exists: $rel (set overwrite=true to replace)")
        }
        WriteCommandAction.runWriteCommandAction(project) {
            Files.createDirectories(target.parent)
            Files.writeString(target, content)
            PathGuard.projectRoot(project).refresh(false, true)
        }
        return mapOf("path" to target.toString(), "bytes" to (content.toByteArray().size))
    }
}