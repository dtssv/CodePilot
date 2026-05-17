package io.codepilot.plugin.toolwindow

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import io.codepilot.plugin.conversation.ConversationClient
import io.codepilot.plugin.session.SessionStore
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.tools.ToolDispatcher
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.cef.browser.CefBrowser
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * JCEF-based chat panel that loads the React WebUI and bridges bidirectional
 * communication via CefMessageRouter.
 *
 * Plugin → Web: executeJavaScript("window.__codepilot_dispatch('eventType', payload)")
 * Web → Plugin: cefQuery({ request: JSON.stringify({type, payload}) })
 */
class CefChatPanel(
    val project: Project,
) : Disposable {
    private val log = logger<CefChatPanel>()
    private val mapper = ObjectMapper()
    private val settings = CodePilotSettings.getInstance()
    private val browser: JBCefBrowser
    private val queryHandler: JBCefJSQuery
    private val sessionStore = SessionStore.getInstance()
    private val client = ConversationClient()
    private val workspaceHash = (project.basePath ?: project.name).hashCode().toString(16)

    /** v2 protocol — see protocol/EventEnvelope.kt + protocol/LegacyEventAdapter.kt. */
    private val eventBus = io.codepilot.plugin.protocol.EventBus.getInstance(project)

    /** v2 adapter for the currently active turn (recreated per user_message). */
    private var legacyAdapter: io.codepilot.plugin.protocol.LegacyEventAdapter? = null

    /** Current active session; nullable — only created on first message. */
    private var sessionHandle: SessionStore.SessionHandle? = null

    /** Tool dispatchers for handling tool_call SSE events during both run and resume. */
    private var dispatcher: ToolDispatcher? = null
    private var gatherDispatcher: io.codepilot.plugin.tools.GatherDispatcher? = null
    private var graphStateStore: io.codepilot.plugin.tools.GraphStateStore? = null
    private var modelCatalog: List<Map<String, Any?>> = emptyList()
    private val usageRecords = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()

    /**
     * Stores full code for context references. Key = contextId, Value = full code text.
     * This avoids embedding full code in messages, keeping messages compact and
     * allowing the code to be re-read from disk if needed.
     */
    private val contextStore = mutableMapOf<String, String>()

    private val panel = JPanel(BorderLayout())

    init {
        // Start with no session — will be created on first message
        sessionHandle = null

        // Wire EventBus -> WebUI:every envelope is mirrored as a single `envelope` event.
        // The new v2 UI listens to this; the legacy UI ignores it harmlessly.
        eventBus.setDispatcher { env ->
            dispatchToWeb(
                "envelope",
                mapOf(
                    "seq" to env.seq,
                    "turnId" to env.turnId,
                    "stepId" to env.stepId,
                    "parentStepId" to env.parentStepId,
                    "ts" to env.ts,
                    "type" to env.type,
                    "payload" to env.payload,
                ),
            )
        }
        io.codepilot.plugin.background.BackgroundTaskManager.getInstance(project).setDispatcher { type, payload ->
            dispatchToWeb(type, payload)
        }

        // Register logout callback so RefreshOn401Interceptor can notify WebUI
        io.codepilot.plugin.transport.RefreshOn401Interceptor.onLogout = {
            dispatchToWeb("auth_state", mapOf("authenticated" to false))
        }

        // Register HTTP logging callback to forward request/response to WebUI console
        io.codepilot.plugin.transport.HttpClientService.getInstance().httpLogCallback =
            { method, url, requestBody, statusCode, durationMs, responseBody ->
                dispatchToWeb("console_log", mapOf(
                    "type" to if (statusCode in 200..299) "info" else "error",
                    "source" to "http",
                    "data" to mapOf(
                        "method" to method,
                        "url" to url,
                        "request" to requestBody,
                        "statusCode" to statusCode,
                        "durationMs" to durationMs,
                        "response" to responseBody,
                    ),
                ))
            }

        browser =
            JBCefBrowser
                .createBuilder()
                .setEnableOpenDevToolsMenuItem(true)
                .build()

        queryHandler = JBCefJSQuery.create(browser)
        queryHandler.addHandler { request ->
            handleWebMessage(request)
            JBCefJSQuery.Response("ok")
        }

        // Inject the cefQuery bridge function after page load
        browser.jbCefClient.addLoadHandler(
            object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(
                    cefBrowser: CefBrowser?,
                    frame: org.cef.browser.CefFrame?,
                    httpStatusCode: Int,
                ) {
                    if (frame?.isMain == true) {
                        injectBridge(cefBrowser!!)
                        // Push session list and current session messages to the WebUI
                        dispatchSessionList()
                        dispatchCurrentSessionInfo()
                        dispatchCurrentSessionMessages()
                    }
                }
            },
            browser.cefBrowser,
        )

        // Load the WebUI
        val webUiPath = resolveWebUiPath()
        browser.loadURL(webUiPath)

        panel.add(browser.component, BorderLayout.CENTER)
        Disposer.register(this, browser)
    }

    val component: JComponent get() = panel

    /** Dispatch an SSE event to the web UI. */
    fun dispatchToWeb(
        eventType: String,
        payload: Any?,
    ) {
        val json = mapper.writeValueAsString(payload)
        val script = "window.__codepilot_dispatch && window.__codepilot_dispatch('$eventType', $json);"
        ApplicationManager.getApplication().invokeLater {
            browser.cefBrowser.executeJavaScript(script, "", 0)
        }
    }

    /**
     * Dispatch a tool_call from external sources (e.g., ActionBase SSE).
     * Routes the tool call to ToolDispatcher for execution and notifies WebUI.
     */
    fun dispatchToolCall(toolCallId: String, toolName: String, args: com.fasterxml.jackson.databind.JsonNode) {
        val handle = sessionHandle ?: return
        // Create a payload node that matches the expected format
        val payload = mapper.createObjectNode()
        payload.put("id", toolCallId)
        payload.put("name", toolName)
        payload.set<com.fasterxml.jackson.databind.JsonNode>("args", args)

        // Notify WebUI for card rendering
        dispatchToWeb("tool_call", mapper.treeToValue(payload, Map::class.java))

        // Dispatch to ToolDispatcher for execution
        val dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { tcId, ok, _ ->
            dispatchToWeb("tool_result_ack", mapOf("toolCallId" to tcId, "ok" to ok))
        })
        dispatcher.dispatch(payload)
    }

    /** Store context fullCode by ID — avoids embedding code in messages. */
    fun storeContext(
        id: String,
        fullCode: String,
    ) {
        contextStore[id] = fullCode
    }

    override fun dispose() {
        // Detach the EventBus dispatcher so a re-opened panel can re-attach cleanly.
        eventBus.setDispatcher(null)
        io.codepilot.plugin.background.BackgroundTaskManager.getInstance(project).setDispatcher(null)
        // browser is disposed via Disposer.register
    }

    /**
     * v2 protocol: re-execute a tool locally and emit a fresh envelope sequence.
     *
     * This bypasses the LLM round-trip — the result is shown to the user but is
     * NOT submitted back via [io.codepilot.plugin.conversation.ConversationClient.submitToolResult],
     * so the model's state is unaffected.
     *
     * Payload: `{ stepId: string, tool: string, args: object }` (stepId only used
     * for the synthetic step label; a fresh stepId is generated for the rerun.)
     */
    private fun handleToolRerun(payload: com.fasterxml.jackson.databind.JsonNode) {
        val tool = payload.path("tool").asText("").takeIf { it.isNotBlank() } ?: return
        val args = payload.path("args")
        val originStep = payload.path("stepId").asText("rerun")
        val bus = eventBus
        val turnId = legacyAdapter?.turnId ?: "rerun-${System.currentTimeMillis()}"
        val rerunStepId = "$originStep-rerun-${System.nanoTime()}"

        bus.startStep(turnId, rerunStepId, io.codepilot.plugin.protocol.StepKinds.TOOL, "$tool (rerun)")
        bus.toolCall(turnId, rerunStepId, tool, args)

        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val handle = sessionHandle
                // Build an ephemeral dispatcher that does not submit results upstream.
                val dummyClient = client
                val tempDispatcher = ToolDispatcher(
                    project,
                    dummyClient,
                    handle?.meta?.id ?: "",
                    onToolResult = { _, ok, result ->
                        val classified = io.codepilot.plugin.protocol.ToolResultClassifier
                            .classify(tool, args, ok, result)
                        bus.toolResult(turnId, rerunStepId, ok, classified, null)
                        bus.endStep(
                            turnId, rerunStepId,
                            if (ok) io.codepilot.plugin.protocol.StepStatuses.SUCCESS
                            else io.codepilot.plugin.protocol.StepStatuses.ERROR,
                        )
                    },
                )
                // Synthesize a tool_call node compatible with ToolDispatcher.dispatch.
                val syntheticId = "rerun-${System.nanoTime()}"
                tempDispatcher.dispatch(tool, mapper.treeToValue(args, Map::class.java), syntheticId)
            } catch (t: Throwable) {
                bus.toolResult(turnId, rerunStepId, false, mapOf(
                    "kind" to "error",
                    "tool" to tool,
                    "errorMessage" to (t.message ?: t.javaClass.simpleName),
                ), t.message)
                bus.endStep(turnId, rerunStepId, io.codepilot.plugin.protocol.StepStatuses.ERROR, t.message)
            }
        }
    }

    /**
     * v2 protocol gap recovery. Called when the WebUI detects a missing seq number
     * and asks the host to re-emit buffered envelopes.
     */
    private fun handleReplaySince(lastSeq: Long) {
        val envelopes = eventBus.replaySince(lastSeq)
        log.info("[Envelope] replay_since lastSeq=$lastSeq -> ${envelopes.size} envelopes")
        envelopes.forEach { env ->
            dispatchToWeb(
                "envelope",
                mapOf(
                    "seq" to env.seq,
                    "turnId" to env.turnId,
                    "stepId" to env.stepId,
                    "parentStepId" to env.parentStepId,
                    "ts" to env.ts,
                    "type" to env.type,
                    "payload" to env.payload,
                ),
            )
        }
    }

    // ---- P0-03 Hunk Apply endpoints ---- //

    private val patchStaging by lazy { io.codepilot.plugin.apply.PatchStaging.getInstance(project) }

    private fun handleApplyList() {
        dispatchToWeb("apply.list_response", mapOf("pending" to patchStaging.snapshot()))
    }

    private fun handleApplyHunkStatus(payload: com.fasterxml.jackson.databind.JsonNode) {
        val pendingId = payload.path("pendingId").asText().ifBlank { return }
        val hunkId = payload.path("hunkId").asText("")
        val status = payload.path("status").asText("pending").uppercase()
        val s = runCatching { io.codepilot.plugin.apply.PatchStaging.HunkStatus.valueOf(status) }
            .getOrDefault(io.codepilot.plugin.apply.PatchStaging.HunkStatus.PENDING)
        if (hunkId == "*") patchStaging.setAllHunks(pendingId, s)
        else patchStaging.setHunkStatus(pendingId, hunkId, s)
    }

    private fun handleApplyApplyFile(payload: com.fasterxml.jackson.databind.JsonNode) {
        val pendingId = payload.path("pendingId").asText().ifBlank { return }
        val result = patchStaging.applyFile(pendingId)
        dispatchToWeb("apply.result", result + mapOf("op" to "apply_file"))
    }

    private fun handleApplyApplyAll(payload: com.fasterxml.jackson.databind.JsonNode) {
        val turnId = payload.path("turnId").asText().ifBlank { legacyAdapter?.turnId ?: return }
        val result = patchStaging.applyAll(turnId)
        dispatchToWeb("apply.result", result + mapOf("op" to "apply_all", "turnId" to turnId))
    }

    private fun handleApplyRejectFile(payload: com.fasterxml.jackson.databind.JsonNode) {
        val pendingId = payload.path("pendingId").asText().ifBlank { return }
        val result = patchStaging.rejectFile(pendingId)
        dispatchToWeb("apply.result", result + mapOf("op" to "reject_file"))
    }

    private fun handleApplyReapply(payload: com.fasterxml.jackson.databind.JsonNode) {
        val pendingId = payload.path("pendingId").asText().ifBlank { return }
        val result = patchStaging.reapply(pendingId)
        dispatchToWeb("apply.result", result + mapOf("op" to "reapply"))
    }

    private fun handleApplyUndoTurn(payload: com.fasterxml.jackson.databind.JsonNode) {
        val turnId = payload.path("turnId").asText().ifBlank { return }
        val result = patchStaging.undoTurn(turnId)
        dispatchToWeb("apply.result", result + mapOf("op" to "undo_turn", "turnId" to turnId))
    }

    // ---- P0-04 Tab completion telemetry ---- //
    private fun handleTabGetStats() {
        val stats = io.codepilot.plugin.completion.TabFeedback.getInstance().snapshot()
        dispatchToWeb("tab.stats_response", stats)
    }

    private fun handleTabResetStats() {
        io.codepilot.plugin.completion.TabFeedback.getInstance().reset()
        dispatchToWeb("tab.stats_response", io.codepilot.plugin.completion.TabFeedback.getInstance().snapshot())
    }

    // ---- P1-05 Codebase index and search ---- //
    private val indexScheduler by lazy { io.codepilot.plugin.indexer.IndexScheduler.getInstance(project) }

    private fun handleCodebaseGetStatus() {
        dispatchToWeb("codebase.status_response", indexScheduler.statusSnapshot())
        indexScheduler.emitStatus()
    }

    private fun handleCodebaseRebuild() {
        indexScheduler.start()
        indexScheduler.triggerFullScan()
        dispatchToWeb("codebase.status_response", indexScheduler.statusSnapshot())
    }

    private fun handleCodebasePause() {
        indexScheduler.pause()
        dispatchToWeb("codebase.status_response", indexScheduler.statusSnapshot())
    }

    private fun handleCodebaseResume() {
        indexScheduler.resume()
        dispatchToWeb("codebase.status_response", indexScheduler.statusSnapshot())
    }

    private fun handleCodebaseSearch(payload: com.fasterxml.jackson.databind.JsonNode) {
        val query = payload.path("query").asText("").trim()
        if (query.isBlank()) return
        val topK = payload.path("topK").asInt(12).coerceIn(1, 50)
        val language = payload.path("language").asText("").takeIf { it.isNotBlank() }
        val t0 = System.currentTimeMillis()
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val hits = indexScheduler.search(query, topK, language).map {
                mapOf(
                    "path" to it.path,
                    "startLine" to it.startLine,
                    "endLine" to it.endLine,
                    "score" to it.score,
                    "snippet" to it.snippet,
                    "symbols" to it.symbols,
                    "matchType" to it.matchType,
                )
            }
            val payloadMap = mapOf(
                "query" to query,
                "hits" to hits,
                "durationMs" to (System.currentTimeMillis() - t0),
            )
            eventBus.emit(
                turnId = "system",
                stepId = "codebase-search-${System.nanoTime()}",
                type = io.codepilot.plugin.protocol.EventTypes.CODEBASE_SEARCH_RESULT,
                payload = payloadMap,
            )
            dispatchToWeb("codebase.search_response", payloadMap)
        }
    }

    private fun handleCodebaseSetIgnore(payload: com.fasterxml.jackson.databind.JsonNode) {
        val patterns = payload.path("patterns")
            .takeIf { it.isArray }
            ?.map { it.asText() }
            ?.filter { it.isNotBlank() }
            ?: emptyList()
        indexScheduler.setIgnorePatterns(patterns)
        dispatchToWeb("codebase.status_response", indexScheduler.statusSnapshot())
    }

    // ---- P1-06 Rules and memories ---- //
    private val rulesService by lazy { io.codepilot.plugin.rules.RulesService.getInstance(project) }
    private val memoryService by lazy { io.codepilot.plugin.memory.MemoryService.getInstance(project) }

    private fun handleRulesReload() {
        val rules = rulesService.reload()
        dispatchToWeb("rules.response", mapOf("rules" to rules.map { it.toDto() }))
    }

    private fun handleRulesList() {
        val rules = rulesService.all()
        dispatchToWeb("rules.response", mapOf("rules" to rules.map { it.toDto() }))
    }

    private fun handleRulesCreate(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("rule-${System.currentTimeMillis()}.mdc")
        val description = payload.path("description").asText(id)
        val globs = payload.path("globs").takeIf { it.isArray }?.map { it.asText() } ?: listOf("**/*")
        val body = payload.path("body").asText("")
        val rule = rulesService.createRule(id, description, globs, body)
        dispatchToWeb("rules.response", mapOf("rules" to rulesService.all().map { it.toDto() }, "created" to rule.toDto()))
    }

    private fun handleMemoryList() {
        dispatchToWeb("memory.response", mapOf("memories" to memoryService.list()))
    }

    private fun handleMemoryUpsert(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("memory-${System.currentTimeMillis()}")
        val memory = io.codepilot.plugin.memory.MemoryService.Memory(
            id = id,
            scope = payload.path("scope").asText("project"),
            kind = payload.path("kind").asText("fact"),
            text = payload.path("text").asText(""),
            confidence = payload.path("confidence").asDouble(0.8),
            status = payload.path("status").asText("suggested"),
        )
        memoryService.upsert(memory)
        dispatchToWeb("memory.response", mapOf("memories" to memoryService.list(), "updated" to memory))
    }

    private fun handleMemorySetStatus(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { return }
        val status = payload.path("status").asText("approved")
        memoryService.setStatus(id, status)
        dispatchToWeb("memory.response", mapOf("memories" to memoryService.list()))
    }

    private fun handleMemoryRemove(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { return }
        memoryService.remove(id)
        dispatchToWeb("memory.response", mapOf("memories" to memoryService.list()))
    }

    // ---- P1-07 MCP and hooks ---- //
    private val mcpService by lazy { io.codepilot.plugin.mcp.McpService.getInstance(project) }
    private val hookEngine by lazy { io.codepilot.plugin.hooks.HookEngine.getInstance(project) }

    private fun handleMcpList() {
        dispatchToWeb("mcp.response", mapOf("servers" to mcpService.list()))
    }

    private fun handleMcpReload() {
        dispatchToWeb("mcp.response", mapOf("servers" to mcpService.reloadConfig()))
    }

    private fun handleMcpStart(payload: com.fasterxml.jackson.databind.JsonNode) {
        val name = payload.path("name").asText("").ifBlank { return }
        mcpService.start(name)
        dispatchToWeb("mcp.response", mapOf("servers" to mcpService.list()))
    }

    private fun handleMcpStop(payload: com.fasterxml.jackson.databind.JsonNode) {
        val name = payload.path("name").asText("").ifBlank { return }
        mcpService.stop(name)
        dispatchToWeb("mcp.response", mapOf("servers" to mcpService.list()))
    }

    private fun handleMcpSetGranted(payload: com.fasterxml.jackson.databind.JsonNode) {
        val server = payload.path("server").asText("").ifBlank { return }
        val tool = payload.path("tool").asText("").ifBlank { return }
        val granted = payload.path("granted").asBoolean(false)
        mcpService.setGranted(server, tool, granted)
        dispatchToWeb("mcp.response", mapOf("servers" to mcpService.list()))
    }

    private fun handleMcpEditConfig(payload: com.fasterxml.jackson.databind.JsonNode) {
        val content = payload.path("content").asText("{}")
        mcpService.editConfig(content)
        dispatchToWeb("mcp.response", mapOf("servers" to mcpService.list()))
    }

    private fun handleHooksList() {
        dispatchToWeb("hooks.response", mapOf("hooks" to hookEngine.list()))
    }

    private fun handleHooksSave(payload: com.fasterxml.jackson.databind.JsonNode) {
        val hooks = payload.path("hooks").takeIf { it.isArray }?.map {
            io.codepilot.plugin.hooks.HookEngine.Hook(
                id = it.path("id").asText("hook-${System.nanoTime()}"),
                event = it.path("event").asText("beforeSubmitPrompt"),
                command = it.path("command").asText(""),
                enabled = it.path("enabled").asBoolean(true),
                timeoutMs = it.path("timeoutMs").asInt(30_000),
            )
        } ?: emptyList()
        hookEngine.writeHooks(hooks)
        dispatchToWeb("hooks.response", mapOf("hooks" to hookEngine.list()))
    }

    // ---- P1-08 Shell policy ---- //
    private val shellPolicy by lazy { io.codepilot.plugin.shell.ShellPolicy.getInstance(project) }

    private fun handleShellPolicyGet() {
        dispatchToWeb("shell.policy_response", shellPolicy.reload())
    }

    private fun handleShellPolicySave(payload: com.fasterxml.jackson.databind.JsonNode) {
        val defaultAction = payload.path("defaultAction").asText("ask")
        val rules = payload.path("rules").takeIf { it.isArray }?.map {
            mapOf(
                "pattern" to it.path("pattern").asText(""),
                "action" to it.path("action").asText("ask"),
            )
        } ?: emptyList()
        shellPolicy.writePolicy(defaultAction, rules)
        dispatchToWeb("shell.policy_response", shellPolicy.snapshot())
    }

    // ---- Private ---- //

    private fun injectBridge(cefBrowser: CefBrowser) {
        val injection =
            """
            (function() {
                if (window.__cefBridgeInjected) return;
                window.__cefBridgeInjected = true;
                window.cefQuery = function(args) {
                    ${queryHandler.inject("args.request", "args.onSuccess", "args.onFailure")}
                };
            })();
            """.trimIndent()
        cefBrowser.executeJavaScript(injection, "", 0)
    }

    private fun handleWebMessage(request: String) {
        try {
            val node = mapper.readTree(request)
            val type = node["type"]?.asText() ?: return
            val payload = node["payload"]

            when (type) {
                "user_message" ->
                    handleUserMessage(
                        payload["text"]?.asText() ?: "",
                        payload["mode"]?.asText() ?: "agent",
                        payload["modelId"]?.asText(),
                        payload["modelSource"]?.asText(),
                        payload["contextRefs"]?.takeIf { it.isArray }?.map { ref ->
                            mapOf(
                                "id" to ref["id"].asText(),
                                "display" to ref["display"].asText(),
                                "type" to ref["type"].asText("file"),
                                "language" to ref["language"].asText("text"),
                                "startLine" to ref["startLine"].asInt(-1).let { if (it < 0) null else it },
                                "endLine" to ref["endLine"].asInt(-1).let { if (it < 0) null else it },
                            )
                        } ?: emptyList(),
                        payload["images"]?.takeIf { it.isArray }?.map { img ->
                            mapOf(
                                "name" to img["name"].asText(""),
                                "mimeType" to img["mimeType"].asText("image/png"),
                                "base64" to img["base64"].asText(""),
                            )
                        } ?: emptyList(),
                        // ★ Conversation history from WebUI for multi-turn context
                        payload["historyMessages"]?.takeIf { it.isArray }?.map { msg ->
                            mapOf(
                                "role" to msg["role"].asText("user"),
                                "content" to msg["content"].asText(""),
                            )
                        } ?: emptyList(),
                        payload["maxMode"]?.asBoolean(false) ?: false,
                    )
                "fetch_models" -> handleFetchModels()
                "stop" -> handleStop()
                "risk_approved" -> handleRiskApproval(payload["approved"]?.asBoolean() ?: false)
                "needs_input_response" -> handleNeedsInputResponse(payload)
                "new_session" -> handleNewSession()
                "list_sessions" -> handleListSessions()
                "switch_session" -> handleSwitchSession(payload["sessionId"]?.asText() ?: return)
                "delete_session" -> handleDeleteSession(payload["sessionId"]?.asText() ?: return)
                "session.pin" -> handleSessionPin(payload)
                "session.archive" -> handleSessionArchive(payload)
                "session.rename" -> handleSessionRename(payload)
                "session.search" -> handleSessionSearch(payload)
                "session.duplicate" -> handleSessionDuplicate(payload)
                "branch.tree" -> handleBranchTree(payload)
                "fork_from_message" -> handleForkFromMessage(payload["messageIndex"]?.asInt() ?: return)
                "switch_branch" -> handleSwitchSession(payload["sessionId"]?.asText() ?: return)
                "voice.start" -> handleVoiceStart()
                "voice.stop" -> handleVoiceStop()
                "usage.get" -> dispatchUsage()
                "ui.notify" -> handleUiNotify(payload)
                "slash.commands.list" -> dispatchSlashCommands()
                "templates.list" -> dispatchTemplates()
                "templates.save" -> handleTemplateSave(payload)
                "templates.delete" -> handleTemplateDelete(payload)
                "bg.submit" -> handleBgSubmit(payload)
                "bg.list" -> handleBgList()
                "bg.cancel" -> handleBgCancel(payload)
                "bg.merge" -> handleBgMerge(payload)
                "bg.discard" -> handleBgDiscard(payload)
                "bg.open_worktree" -> handleBgOpenWorktree(payload)
                "export.preview" -> handleExportPreview(payload)
                "export.save_file" -> handleExportSave(payload)
                "share.create" -> handleShareCreate(payload)
                // Auth messages from login page
                "check_auth" -> handleCheckAuth()
                "auth_discover" -> handleAuthDiscover()
                "auth_login_bridge" -> handleAuthLoginBridge(payload["token"]?.asText() ?: return)
                "auth_login_dev" ->
                    handleAuthLoginDev(
                        payload["token"]?.asText() ?: return,
                        payload["userId"]?.asText() ?: return,
                        payload["tenantId"]?.asText() ?: return,
                    )
                "auth_login_oidc" -> handleAuthLoginOidc()
                // ★ @-reference resolution and patch events
                "at_suggest" -> handleAtSuggest(payload["query"]?.asText() ?: "")
                "at_resolve" -> handleAtResolve(payload["id"]?.asText() ?: return, payload["chipId"]?.asText())
                "apply_patches" -> handleApplyPatches(payload)
                "apply_selected_hunks" -> handleApplySelectedHunks(payload)
                // ★ Integration: Apply single code block from Chat code-block Apply button
                "apply_code_block" -> handleApplyCodeBlock(payload)
                // ★ Integration: Bug scan triggered from chat or action
                "bug_scan" -> handleBugScan(payload)
                // ★ Plan edit handlers for Agent mode
                "plan_edit" -> handlePlanEdit(payload)
                "continue_run" -> handleContinueRun()
                "replan" -> handleReplan()
                "resume_session" -> handleResumeSession()
                "update_auto_apply" -> handleUpdateAutoApply(payload)
                // v2 protocol: gap recovery — re-emit all envelopes with seq > lastSeq
                "replay_since" -> handleReplaySince(payload["lastSeq"]?.asLong() ?: 0L)
                // v2 protocol: re-execute a tool locally for user inspection (no LLM feedback).
                "tool.rerun" -> handleToolRerun(payload)
                // P0-03 hunk apply
                "apply.list" -> handleApplyList()
                "apply.hunk_status" -> handleApplyHunkStatus(payload)
                "apply.apply_file" -> handleApplyApplyFile(payload)
                "apply.apply_all" -> handleApplyApplyAll(payload)
                "apply.reject_file" -> handleApplyRejectFile(payload)
                "apply.reapply" -> handleApplyReapply(payload)
                "apply.undo_turn" -> handleApplyUndoTurn(payload)
                // P0-04 tab completion settings
                "tab.get_stats" -> handleTabGetStats()
                "tab.reset_stats" -> handleTabResetStats()
                // P1-05 codebase index/search
                "codebase.get_status" -> handleCodebaseGetStatus()
                "codebase.rebuild" -> handleCodebaseRebuild()
                "codebase.pause" -> handleCodebasePause()
                "codebase.resume" -> handleCodebaseResume()
                "codebase.search" -> handleCodebaseSearch(payload)
                "codebase.set_ignore" -> handleCodebaseSetIgnore(payload)
                // P1-06 rules and memories
                "rules.reload" -> handleRulesReload()
                "rules.list" -> handleRulesList()
                "rules.create" -> handleRulesCreate(payload)
                "memory.list" -> handleMemoryList()
                "memory.upsert" -> handleMemoryUpsert(payload)
                "memory.set_status" -> handleMemorySetStatus(payload)
                "memory.remove" -> handleMemoryRemove(payload)
                // P1-07 MCP + hooks
                "mcp.list_servers" -> handleMcpList()
                "mcp.reload" -> handleMcpReload()
                "mcp.start" -> handleMcpStart(payload)
                "mcp.stop" -> handleMcpStop(payload)
                "mcp.set_granted" -> handleMcpSetGranted(payload)
                "mcp.edit_config" -> handleMcpEditConfig(payload)
                "hooks.list" -> handleHooksList()
                "hooks.save" -> handleHooksSave(payload)
                // P1-08 shell policy
                "shell.policy_get" -> handleShellPolicyGet()
                "shell.policy_save" -> handleShellPolicySave(payload)
                else -> log.warn("Unknown message type from web: $type")
            }
        } catch (e: Exception) {
            log.error("Failed to handle web message: $request", e)
        }
    }

    private fun handleUserMessage(
        text: String,
        mode: String,
        modelId: String? = null,
        modelSource: String? = null,
        contextRefs: List<Map<String, Any?>> = emptyList(),
        images: List<Map<String, String>> = emptyList(),
        // ★ Conversation history from WebUI for multi-turn context
        historyMessages: List<Map<String, String>> = emptyList(),
        maxMode: Boolean = false,
    ) {
        // Ensure a session exists (lazy creation on first message)
        val routedModel = routeModel(modelId, text, mode, images.isNotEmpty(), maxMode)
        val effectiveModelId = routedModel["id"] as? String ?: modelId
        val effectiveModelSource = routedModel["source"] as? String ?: modelSource
        if (sessionHandle == null) {
            sessionHandle = sessionStore.newSession(workspaceHash, mode, effectiveModelId, effectiveModelSource)
        }
        val handle = sessionHandle!!

        // Display text is just the user's text — context refs are shown as chips via contextRefs field
        val displayText = text

        // Persist the compact display message locally (including contextRefs for session restore)
        val userMsgExtra = mutableMapOf<String, Any?>()
        if (contextRefs.isNotEmpty()) userMsgExtra["contextRefs"] = contextRefs
        sessionStore.appendMessage(handle, "user", displayText, userMsgExtra.toMap())
        // Auto-derive title from first user message
        if (handle.meta.title.isNullOrBlank()) {
            sessionStore.updateMeta(handle) { meta ->
                meta.title = text.take(50)
            }
        }
        sessionStore.touchLastMessage(handle)
        // Notify WebUI with compact display message
        dispatchToWeb(
            "user_message_saved",
            mapOf(
                "role" to "user",
                "content" to displayText,
                "contextRefs" to contextRefs,
            ),
        )

        // v2 protocol: start a new turn envelope flow for this user message.
        // The adapter is kept on the panel instance and consumed inside the SSE listener.
        val turnId = "turn-${System.currentTimeMillis()}-${kotlin.math.abs(text.hashCode())}"
        legacyAdapter = io.codepilot.plugin.protocol.LegacyEventAdapter(eventBus, turnId)
        legacyAdapter!!.onTurnStart(displayText, contextRefs)

        // Build the full message for backend (replace inline placeholders with actual code)
        val fullText =
            buildString {
                var remaining = text
                while (true) {
                    val start = remaining.indexOf('\u0001')
                    if (start < 0) {
                        append(remaining)
                        break
                    }
                    append(remaining.substring(0, start))
                    val end = remaining.indexOf('\u0001', start + 1)
                    if (end < 0) {
                        append(remaining.substring(start))
                        break
                    }
                    val ctxId = remaining.substring(start + 1, end)
                    val fullCode = contextStore[ctxId]
                    if (fullCode != null) {
                        val ref = contextRefs.find { it["id"] == ctxId }
                        val refType = ref?.get("type") as? String ?: "file"
                        val lang = ref?.get("language") as? String ?: "text"
                        val display = ref?.get("display") as? String ?: "context"
                        val loc = if (ref?.get("startLine") != null) " :${ref["startLine"]}-${ref["endLine"]}" else ""
                        // Format context differently based on type
                        when (refType) {
                            "web" -> {
                                appendLine("Web Content: $display")
                                appendLine(fullCode)
                            }
                            "git" -> {
                                appendLine("Git Context: $display")
                                appendLine("```")
                                appendLine(fullCode)
                                appendLine("```")
                            }
                            "terminal" -> {
                                appendLine("Terminal Output: $display")
                                appendLine("```")
                                appendLine(fullCode)
                                appendLine("```")
                            }
                            "codebase" -> {
                                appendLine("Codebase Search: $display")
                                appendLine(fullCode)
                            }
                            "symbol" -> {
                                appendLine("Symbol: $display$loc")
                                appendLine("```$lang")
                                appendLine(fullCode)
                                appendLine("```")
                            }
                            else -> {
                                // file, folder, docs, code, package
                                appendLine("Context: $display$loc")
                                appendLine("```$lang")
                                appendLine(fullCode)
                                appendLine("```")
                            }
                        }
                    }
                    remaining = remaining.substring(end + 1)
                }
            }
        dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { toolCallId, ok, result ->
            dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok))
            legacyAdapter?.onToolResultAck(toolCallId, ok, result)
            sessionStore.appendStep(handle, mapOf(
                "toolCallId" to toolCallId,
                "ok" to ok,
                "ts" to java.time.Instant.now().toString(),
            ))
        }).apply { currentTurnId = turnId }
        gatherDispatcher =
            io.codepilot.plugin.tools
                .GatherDispatcher(project, client, handle.meta.id) { toolCallId, ok, httpResponse ->
                    // Dispatch tool_result_ack to WebUI when gather execution completes
                    dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok))
                    // Record the tool result step
                    sessionStore.appendStep(handle, mapOf(
                        "toolCallId" to toolCallId,
                        "ok" to ok,
                        "ts" to java.time.Instant.now().toString(),
                    ))
                }
        graphStateStore =
            io.codepilot.plugin.tools
                .GraphStateStore(project, handle.dir)

        ApplicationManager.getApplication().executeOnPooledThread {
            // Capture nullable class members as local non-null vals for safe usage in listener
            val gss = graphStateStore!!
            val disp = dispatcher!!
            val gd = gatherDispatcher!!

            val payload =
                mutableMapOf<String, Any?>(
                    "sessionId" to handle.meta.id,
                    "mode" to mode,
                    "input" to fullText,
                    "intent" to "new",
                )
            if (effectiveModelId != null && effectiveModelId != "auto") payload["modelId"] = effectiveModelId
            if (effectiveModelSource != null) payload["modelSource"] = effectiveModelSource

            // ★ Inject project meta (language, root files) so LLM knows project context
            payload["projectMeta"] = buildProjectMeta()

            // ★ Inject MCP server configs so backend knows which MCP tools are available
            val mcpServers = io.codepilot.plugin.marketplace.LocalMarketplaceStore.getInstance().installedMcpServers()
            if (mcpServers.isNotEmpty()) {
                payload["userMcps"] = mcpServers.map { server ->
                    mapOf(
                        "id" to server.id,
                        "version" to server.version,
                        "source" to "marketplace",
                        "scope" to "global",
                        "projectRootHash" to "",
                        "permissions" to mapOf(
                            "transport" to server.transport.value,
                            "url" to (server.url ?: ""),
                            "headers" to server.headers,
                            "tools" to emptyList<String>(),
                        ),
                    )
                }
                // ★ Also fetch and inject MCP tool metadata for prompt injection
                try {
                    val mcpTools = dispatcher?.initMcpServers() ?: emptyList()
                    if (mcpTools.isNotEmpty()) {
                        payload["mcpTools"] = mcpTools
                    }
                } catch (e: Exception) {
                    com.intellij.openapi.diagnostic.Logger.getInstance("CefChatPanel")
                        .warn("Failed to fetch MCP tool metadata: ${e.message}")
                }
            }
            if (images.isNotEmpty()) {
                payload["images"] = images.map { img ->
                    mapOf(
                        "data" to "data:${img["mimeType"]};base64,${img["base64"]}",
                        "mimeType" to (img["mimeType"] ?: "image/png"),
                        "description" to (img["name"] ?: ""),
                    )
                }
            }

            // Resume from graph awaiting state if applicable
            if (mode == "agent") {
                gss.loadLatest()
                if (gss.isAwaiting()) {
                    payload["intent"] = "continue"
                    payload["graphState"] = gss.snapshot()
                    // Clear awaiting after sending resume — next message should be a fresh turn
                    gss.clearAwaiting()
                }
            }

            // ★ MNI (Minimum Necessary Information) assembly for context budget
            // Load local state for context optimization
            val plan = sessionStore.loadPlan(handle)
            val ledger = sessionStore.loadLedger(handle)
            val digest = sessionStore.loadDigest(handle)
            val completedToolCalls =
                sessionStore
                    .completedToolCallIds(handle)
                    .toList()
                    .takeLast(5)
                    .map { id -> mapOf("toolCallId" to id, "ok" to true) }
            val lastMessages = sessionStore.readMessages(handle).takeLast(6)
            val lastAssistantSummary =
                lastMessages
                    .lastOrNull { it["role"] == "assistant" }
                    ?.let { (it["content"] as? String)?.takeLast(1600) }

            // Inject MNI fields into payload
            if (plan != null) payload["lastPlanDigest"] = plan
            if (ledger != null) payload["taskLedger"] = ledger
            if (digest != null) payload["sessionDigest"] = digest
            if (completedToolCalls.size > 0) payload["completedToolCallsTail"] = completedToolCalls
            if (lastAssistantSummary != null) payload["lastAssistantTurnSummary"] = lastAssistantSummary

            // P1-06: inject active .mdc / AGENTS.md / legacy project rules plus
            // approved memories into backend PromptOrchestrator.projectRules.
            val workingFiles = contextRefs.mapNotNull { it["display"] as? String }
            val rulesText = io.codepilot.plugin.rules.RulesService
                .getInstance(project)
                .renderForSystemPrompt(
                    io.codepilot.plugin.rules.RulesService.getInstance(project).activeFor(workingFiles),
                )
            val memoryText = io.codepilot.plugin.memory.MemoryService.getInstance(project).renderApproved()
            val promptFragments = listOf(rulesText, memoryText).filter { it.isNotBlank() }
            if (promptFragments.isNotEmpty()) payload["projectRules"] = promptFragments
            // ★ Build recent messages: merge WebUI-provided history with local session messages
            // WebUI history takes priority as it contains the full conversation context
            // Local session messages serve as fallback when WebUI history is empty
            val webUiHistory = historyMessages.takeLast(10).map { msg ->
                mapOf("role" to msg["role"], "content" to msg["content"]?.take(2000))
            }
            val localRecent = lastMessages.takeLast(6).map { msg ->
                mapOf("role" to msg["role"], "content" to (msg["content"] as? String)?.take(2000))
            }
            // Use WebUI history if available, otherwise fall back to local session messages
            val recentMessages = if (webUiHistory.isNotEmpty()) webUiHistory else localRecent

            payload["contexts"] =
                mapOf(
                    "pinned" to emptyList<Any>(),
                    "recent" to recentMessages,
                    "refs" to contextRefs,
                )
            // Estimate and report context usage
            val estimatedTokens = sessionStore.estimateTokenCount(handle)
            dispatchToWeb(
                "context_budget",
                mapOf(
                    "current" to estimatedTokens,
                    "total" to 24000,
                    "estimated" to 0,
                    "breakdown" to budgetBreakdown(rulesText, memoryText, contextRefs, recentMessages, estimatedTokens),
                ),
            )
            payload["policy"] =
                mapOf(
                    "requestCompact" to "auto",
                    "selfCheck" to true,
                    "askPolicy" to "prefer-ask",
                    "contextBudgetTokens" to 24000,
                    "keepRecentMessages" to 6,
                    "maxSteps" to 25,
                    "thinkingMode" to if (maxMode) "high" else null,
                    "maxOutputTokens" to if (maxMode) 8192 else null,
                    "maxMode" to maxMode,
                )

            val hookResult = io.codepilot.plugin.hooks.HookEngine.getInstance(project).run(
                "beforeSubmitPrompt",
                mapOf("sessionId" to handle.meta.id, "mode" to mode, "message" to text.take(500)),
            )
            if (!hookResult.pass) {
                dispatchToWeb("error", mapOf("code" to 49901, "message" to "Blocked by hook: ${hookResult.reason}"))
                return@executeOnPooledThread
            }

            // Collect full assistant response for local persistence
            val assistantBuilder = StringBuilder()
            // ★ Guard to prevent duplicate assistant message persistence on double done events
            var assistantPersisted = false

            // Capture adapter for use inside the anonymous listener
            val adapter = legacyAdapter
            client.run(
                payload.toMap(),
                object : ConversationClient.Listener {
                    override fun onDelta(text: String) {
                        assistantBuilder.append(text)
                        dispatchToWeb("delta", mapOf("text" to text))
                        adapter?.onTextDelta(text)
                    }

                    override fun onToolCall(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("tool_call", data)
                        val toolName = payload.path("name").asText(null)
                        val toolCallId = payload.path("id").asText(null)
                        if (toolName != null && toolCallId != null) {
                            adapter?.onToolCall(toolCallId, toolName, payload.path("args"))
                            // Persist tool call step for session recovery (started, no result yet)
                            sessionStore.appendStep(handle, mapOf(
                                "toolCallId" to toolCallId,
                                "toolName" to toolName,
                                "stepId" to "",
                                "started" to true,
                                "ts" to java.time.Instant.now().toString(),
                            ))
                            // Update checkpoint for resume capability
                            sessionStore.saveCheckpoint(handle, mapOf(
                                "lastToolCallId" to toolCallId,
                                "lastToolName" to toolName,
                                "ts" to java.time.Instant.now().toString(),
                            ))
                            // Mark session as running (for abnormal termination detection)
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = true
                            }
                            disp.dispatch(payload)
                        }
                    }

                    override fun onToolResultAck(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // This SSE event from backend is a secondary confirmation.
                        // The primary tool_result_ack is already dispatched by ToolDispatcher.onToolResult callback.
                        // Just forward to UI as a backup in case the backend sends this event.
                        val toolCallId = payload.path("toolCallId").asText(null) ?: payload.path("id").asText(null)
                        val ok = payload.path("ok").asBoolean(true)
                        if (toolCallId != null) {
                            dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok))
                        }
                    }

                    override fun onPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("plan", data)
                        sessionStore.savePlan(handle, data)
                    }

                    override fun onPlanDelta(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("plan_delta", mapper.treeToValue(payload, Map::class.java))

                    override fun onTaskLedger(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("task_ledger", data)
                        sessionStore.saveLedger(handle, data)
                    }

                    override fun onRiskNotice(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("risk_notice", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onRiskNotice(mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onNeedsInput(mapper.treeToValue(payload, Map::class.java))
                    }

                    // ── Bidirectional Memory: summaryForNextTurn + hintsForContext ──
                    override fun onSelfCheck(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("self_check", data)
                        // Consume summaryForNextTurn: inject into next turn context
                        val summary = payload.path("summaryForNextTurn").asText(null)
                        if (summary != null && summary.isNotBlank()) {
                            // Store as session digest for next turn consumption
                            sessionStore.saveDigest(handle, mapOf("summaryForNextTurn" to summary))
                            dispatchToWeb("memory_summary", mapOf("summaryForNextTurn" to summary))
                        }
                        // Consume hintsForContext: pin/unpin hints for context optimization
                        val hints = payload.path("hintsForContext")
                        if (hints != null && !hints.isNull && hints.isObject) {
                            val pinList = hints.path("pin")
                            val unpinList = hints.path("unpin")
                            val hintData = mutableMapOf<String, Any>()
                            if (pinList != null && pinList.isArray) hintData["pin"] = pinList
                            if (unpinList != null && unpinList.isArray) hintData["unpin"] = unpinList
                            if (hintData.isNotEmpty()) {
                                dispatchToWeb("memory_hints", hintData)
                            }
                        }
                    }

                    // ── Graph engine events (internal, not shown to user) ──
                    override fun onGraphPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        gss.applyGraphPlan(payload)
                    }

                    override fun onGraphTransition(payload: com.fasterxml.jackson.databind.JsonNode) {
                        gss.applyTransition(payload)
                    }

                    override fun onGraphInfoRequest(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // Execute client-side gather requests silently
                        // Pass the toolCallId so the backend's ToolResultBus can match results
                        val toolCallId = payload.path("toolCallId").asText("gather-batch")
                        gd.dispatchBatch(payload.path("requests"), toolCallId)
                    }

                    override fun onGraphInfoResult(payload: com.fasterxml.jackson.databind.JsonNode) {
                        gss.applyInfoResult(payload)
                    }

                    override fun onGraphVerify(payload: com.fasterxml.jackson.databind.JsonNode) {
                        gss.applyVerify(payload)
                    }

                    override fun onGraphRepairPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // internal only, no UI dispatch
                    }

                    override fun onGraphPhaseDone(payload: com.fasterxml.jackson.databind.JsonNode) {
                        gss.applyPhaseDone(payload)
                    }

                    override fun onGraphBudgetAlert(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // internal only, no UI dispatch
                    }

                    // ── User-facing plan events (shown in Plan panel) ──
                    override fun onUserPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("user_plan", data)
                        adapter?.onPlanUpdate(data)
                    }

                    override fun onUserPlanProgress(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan_progress", mapper.treeToValue(payload, Map::class.java))

                    // ── Interactive Agent events (semantic layer for user-facing steps) ──
                    override fun onAgentThinking(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("agent_thinking", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentThinking(payload.path("text").asText(null))
                    }

                    override fun onAgentReading(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("agent_reading", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentReading(payload.path("summary").asText(null))
                    }

                    override fun onAgentWriting(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("agent_writing", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentWriting(payload.path("text").asText(null))
                    }

                    override fun onAgentRunning(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("agent_running", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentRunning(payload.path("text").asText(null))
                    }

                    override fun onError(
                        code: Int,
                        message: String,
                    ) {
                        dispatchToWeb("error", mapOf("code" to code, "message" to message))
                        adapter?.onError(code, message)
                    }

                    override fun onDone(
                        reason: String,
                        payload: com.fasterxml.jackson.databind.JsonNode,
                    ) {
                        dispatchToWeb("done", mapOf("reason" to reason))
                        adapter?.onDone(reason)
                        // Persist graph awaiting state for resume
                        if (reason == "awaiting_user_input" || reason == "phase_done") {
                            gss.applyAwaiting(payload)
                        }
                        // ★ Only persist the assistant message on the FIRST done event
                        // with a "final" reason. Subsequent done events (e.g., from a
                        // duplicate ConversationService append) should be ignored to
                        // prevent duplicate message persistence.
                        // Intermediate done events (subtask_done, phase_done) should NOT
                        // trigger persistence — the graph execution is still in progress.
                        val isTerminalDone = reason == "final" || reason == "failed" || reason == "stopped" || reason == "max_steps"
                        if (isTerminalDone && !assistantPersisted) {
                            assistantPersisted = true
                            // Persist the full assistant response and update session metadata
                            val fullResponse = assistantBuilder.toString()
                            // Rebuild tool calls from steps: merge "started" and "ok" records by toolCallId
                            val steps = sessionStore.readSteps(handle)
                            val toolCallMap = linkedMapOf<String, Map<String, Any>>()
                            for (step in steps) {
                                val tcId = step["toolCallId"] as? String ?: continue
                                val existing = toolCallMap[tcId]
                                if (step["started"] == true) {
                                    // Tool call started — record name
                                    toolCallMap[tcId] = mapOf(
                                        "id" to tcId,
                                        "name" to (step["toolName"] ?: "unknown"),
                                        "status" to "running",
                                    )
                                } else if (step["ok"] != null) {
                                    // Tool result ack — update status
                                    val name = existing?.get("name") ?: "unknown"
                                    toolCallMap[tcId] = mapOf<String, Any>(
                                        "id" to tcId,
                                        "name" to name,
                                        "status" to if (step["ok"] == true) "success" else "error",
                                    )
                                }
                            }
                            val turnToolCalls = toolCallMap.values.toList()
                            if (fullResponse.isNotEmpty() || turnToolCalls.isNotEmpty()) {
                                val extra = mutableMapOf<String, Any?>()
                                if (turnToolCalls.isNotEmpty()) extra["toolCalls"] = turnToolCalls
                                sessionStore.appendMessage(handle, "assistant", fullResponse, extra.toMap())
                            }
                            // Mark session as not running (clean completion)
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = false
                                meta.abnormalTermination = false
                            }
                            sessionStore.touchLastMessage(handle)
                            recordUsage(handle.meta.id, turnId, effectiveModelId ?: "default", routedModel["tier"] as? String ?: "DEFAULT", fullText, fullResponse)
                            dispatchSessionList() // refresh sidebar timestamps
                        }
                    }

                    override fun onClosed() {
                        // v2 protocol: emit turn.end(interrupted) if no terminal done was seen.
                        adapter?.onAbnormalClose()
                        // If the stream closed without a proper "done" event, the session
                        // was abnormally terminated. Mark it for recovery UI.
                        val isRunning = sessionHandle?.meta?.running == true
                        if (isRunning) {
                            sessionHandle?.let { handle ->
                                sessionStore.updateMeta(handle) { meta ->
                                    meta.running = false
                                    meta.abnormalTermination = true
                                }
                                // Persist whatever assistant text was collected so far
                                val partialResponse = assistantBuilder.toString()
                                if (partialResponse.isNotEmpty()) {
                                    sessionStore.appendMessage(handle, "assistant", partialResponse)
                                }
                                // Notify UI about the abnormal termination
                                dispatchToWeb("session_interrupted", mapOf(
                                    "sessionId" to handle.meta.id,
                                    "hasCheckpoint" to sessionStore.hasCheckpoint(handle),
                                ))
                            }
                        }
                    }
                },
            )
        }
    }

    /** Fetches available models from backend and dispatches to web UI. */
    private fun handleFetchModels() {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                doFetchModels()
            } catch (e: Exception) {
                log.error("Failed to fetch models", e)
            }
        }
    }

    private fun doFetchModels(retries: Int = 1) {
        val http =
            io.codepilot.plugin.transport.HttpClientService
                .getInstance()
        val baseUrl =
            io.codepilot.plugin.settings.CodePilotSettings
                .getInstance()
                .state.backendBaseUrl
                .trimEnd('/')
        val url = baseUrl + "/v1/models"
        log.info("[Models] Fetching models from: $url")
        val request =
            okhttp3.Request
                .Builder()
                .url(url.toHttpUrl())
                .get()
                .header("Accept", "application/json")
                .build()
        val response = http.client().newCall(request).execute()
        response.use { resp ->
            log.info("[Models] Response: code=${resp.code}, message=${resp.message}, protocol=${resp.protocol}, headers=${resp.headers}")
            if (resp.isSuccessful) {
                val body = resp.body?.string() ?: return
                log.info("[Models] Body length: ${body.length}")
                val node = mapper.readTree(body)
                val data = node.path("data")
                val raw = mapper.treeToValue(data, Map::class.java) as Map<*, *>
                val enriched = enrichModelCatalog(raw)
                modelCatalog = ((enriched["system"] as? List<Map<String, Any?>>) ?: emptyList()) +
                    ((enriched["custom"] as? List<Map<String, Any?>>) ?: emptyList())
                dispatchToWeb("models_loaded", enriched)
            } else if (resp.code == 401 && retries > 0) {
                log.warn("[Models] Got 401, prompting login (retries=$retries)")
                SwingUtilities.invokeLater {
                    val loggedIn =
                        io.codepilot.plugin.auth
                            .LoginDialog(project)
                            .showAndGet()
                    if (loggedIn) {
                        ApplicationManager.getApplication().executeOnPooledThread {
                            try {
                                doFetchModels(retries - 1)
                            } catch (e: Exception) {
                                log.error("[Models] Failed after login", e)
                            }
                        }
                    }
                }
            } else {
                val errorBody = runCatching { resp.body?.string()?.take(500) }.getOrNull()
                log.warn("[Models] Failed: code=${resp.code}, body=$errorBody")
            }
        }
    }

    private fun enrichModelCatalog(raw: Map<*, *>): Map<String, Any?> {
        fun enrich(source: String, rows: Any?): List<Map<String, Any?>> =
            (rows as? List<*>)?.mapNotNull { row ->
                val m = row as? Map<*, *> ?: return@mapNotNull null
                val id = m["id"]?.toString() ?: m["model"]?.toString() ?: return@mapNotNull null
                val name = m["name"]?.toString() ?: id
                val modelName = m["model"]?.toString() ?: id
                val caps = (m["capabilities"] as? List<*>)?.mapNotNull { it?.toString() } ?: capabilitiesFor(modelName)
                m.mapKeys { it.key.toString() } + mapOf(
                    "id" to id,
                    "name" to name,
                    "type" to (m["type"]?.toString() ?: source),
                    "source" to (m["source"]?.toString() ?: if (source == "custom") "custom" else "group"),
                    "tier" to (m["tier"]?.toString() ?: tierFor(modelName)),
                    "capabilities" to caps,
                    "contextWindow" to (m["contextWindow"] ?: if ("LONG_CTX_1M" in caps) 1_000_000 else if ("LONG_CTX_256K" in caps) 256_000 else 128_000),
                )
            } ?: emptyList()
        return mapOf("system" to enrich("system", raw["system"]), "custom" to enrich("custom", raw["custom"]))
    }

    private fun handleStop() {
        val sid = sessionHandle?.meta?.id ?: return
        client.stop(sid)
    }

    /**
     * Build project metadata string for LLM context.
     * Includes: detected languages, framework hints, root-level file listing.
     * This prevents the LLM from guessing non-existent files like package.json or requirements.txt.
     */
    private fun buildProjectMeta(): String {
        val base = project.basePath ?: return ""
        val root = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(base)
            ?: return ""

        // Detect languages from file extensions in root and first-level subdirectories
        val extensions = mutableSetOf<String>()
        val rootEntries = mutableListOf<String>()
        for (child in root.children.take(200)) {
            val entry = if (child.isDirectory) "${child.name}/" else child.name
            rootEntries.add(entry)
            if (!child.isDirectory) {
                val ext = child.extension?.lowercase()
                if (ext != null) extensions.add(ext)
            }
        }

        // Also scan first-level subdirectories for language hints
        for (child in root.children.take(50)) {
            if (child.isDirectory) {
                for (subChild in child.children.take(30)) {
                    if (!subChild.isDirectory) {
                        val ext = subChild.extension?.lowercase()
                        if (ext != null) extensions.add(ext)
                    }
                }
            }
        }

        // Map extensions to language names
        val languages = mutableSetOf<String>()
        for (ext in extensions) {
            when (ext) {
                "java", "kt", "kts" -> languages.add(if (ext == "java") "Java" else "Kotlin")
                "cpp", "cc", "cxx", "c", "h", "hpp", "hxx" -> languages.add("C/C++")
                "py" -> languages.add("Python")
                "js", "mjs", "cjs" -> languages.add("JavaScript")
                "ts", "tsx" -> languages.add("TypeScript")
                "go" -> languages.add("Go")
                "rs" -> languages.add("Rust")
                "rb" -> languages.add("Ruby")
                "swift" -> languages.add("Swift")
                "scala" -> languages.add("Scala")
                "xml", "gradle", "properties" -> languages.add("Build Config")
            }
        }

        return buildString {
            if (languages.isNotEmpty()) {
                appendLine(
                    "Project languages: ${languages.joinToString(", ")}",
                )
            }
            appendLine("Root directory entries (${rootEntries.size}):")
            for (entry in rootEntries.take(50)) {
                appendLine("  $entry")
            }
        }
    }

    /**
     * Resume a session that was abnormally terminated.
     * Uses the SessionStore.buildResumePayload to reconstruct the context
     * and calls /v1/conversation/resume to continue the task.
     */
    private fun handleResumeSession() {
        val handle = sessionHandle ?: return
        val meta = handle.meta

        // Only resume if there's a checkpoint and session was abnormally terminated
        if (!sessionStore.hasCheckpoint(handle)) {
            log.warn("[Resume] No checkpoint found for session ${meta.id}")
            dispatchToWeb("error", mapOf("code" to 40401, "message" to "No checkpoint found for this session"))
            return
        }

        ApplicationManager.getApplication().executeOnPooledThread {
            val modelId = meta.modelId ?: "default"
            val resumePayload = sessionStore.buildResumePayload(
                handle,
                "继续之前中断的任务",
                modelId,
            )

            // Mark session as running again
            sessionStore.updateMeta(handle) { meta ->
                meta.running = true
                meta.abnormalTermination = false
            }

            // Notify UI that resume has started
            dispatchToWeb("session_resuming", mapOf("sessionId" to handle.meta.id))

            val dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { toolCallId, ok, _ ->
            // Dispatch tool_result_ack to WebUI immediately when tool execution completes
            dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok))
            // Record the tool result step
            sessionStore.appendStep(handle, mapOf(
                "toolCallId" to toolCallId,
                "ok" to ok,
                "ts" to java.time.Instant.now().toString(),
            ))
        })
            val gatherDispatcher = io.codepilot.plugin.tools.GatherDispatcher(project, client, handle.meta.id)
            val graphStateStore = io.codepilot.plugin.tools.GraphStateStore(project, handle.dir)
            val assistantBuilder = StringBuilder()
            // ★ Guard to prevent duplicate assistant message persistence on double done events
            var assistantPersisted = false

            client.resume(
                resumePayload,
                object : ConversationClient.Listener {
                    override fun onDelta(text: String) {
                        assistantBuilder.append(text)
                        dispatchToWeb("delta", mapOf("text" to text))
                    }

                    override fun onToolCall(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("tool_call", data)
                        val toolName = payload.path("name").asText(null)
                        val toolCallId = payload.path("id").asText(null)
                        if (toolName != null && toolCallId != null) {
                            sessionStore.appendStep(handle, mapOf(
                                "toolCallId" to toolCallId,
                                "toolName" to toolName,
                                "stepId" to "",
                                "started" to true,
                                "ts" to java.time.Instant.now().toString(),
                            ))
                            sessionStore.saveCheckpoint(handle, mapOf(
                                "lastToolCallId" to toolCallId,
                                "lastToolName" to toolName,
                                "ts" to java.time.Instant.now().toString(),
                            ))
                            dispatcher.dispatch(payload)
                        }
                    }

                    override fun onToolResultAck(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val toolCallId = payload.path("toolCallId").asText(null) ?: payload.path("id").asText(null)
                        val ok = payload.path("ok").asBoolean(true)
                        dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok))
                        if (toolCallId != null) {
                            sessionStore.appendStep(handle, mapOf(
                                "toolCallId" to toolCallId, "ok" to ok,
                                "ts" to java.time.Instant.now().toString(),
                            ))
                        }
                    }

                    override fun onPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("plan", data)
                        sessionStore.savePlan(handle, data)
                    }

                    override fun onPlanDelta(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("plan_delta", mapper.treeToValue(payload, Map::class.java))

                    override fun onTaskLedger(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("task_ledger", data)
                        sessionStore.saveLedger(handle, data)
                    }

                    override fun onRiskNotice(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("risk_notice", mapper.treeToValue(payload, Map::class.java))

                    override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))

                    override fun onSelfCheck(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("self_check", data)
                    }

                    override fun onGraphPlan(payload: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyGraphPlan(payload)
                    override fun onGraphTransition(payload: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyTransition(payload)
                    override fun onGraphInfoRequest(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val toolCallId = payload.path("toolCallId").asText("gather-batch")
                        gatherDispatcher.dispatchBatch(payload.path("requests"), toolCallId)
                    }
                    override fun onGraphInfoResult(payload: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyInfoResult(payload)
                    override fun onGraphVerify(payload: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyVerify(payload)
                    override fun onGraphRepairPlan(payload: com.fasterxml.jackson.databind.JsonNode) {}
                    override fun onGraphPhaseDone(payload: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyPhaseDone(payload)
                    override fun onGraphBudgetAlert(payload: com.fasterxml.jackson.databind.JsonNode) {}
                    override fun onUserPlan(payload: com.fasterxml.jackson.databind.JsonNode) = dispatchToWeb("user_plan", mapper.treeToValue(payload, Map::class.java))
                    override fun onUserPlanProgress(payload: com.fasterxml.jackson.databind.JsonNode) = dispatchToWeb("user_plan_progress", mapper.treeToValue(payload, Map::class.java))

                    override fun onError(code: Int, message: String) =
                        dispatchToWeb("error", mapOf("code" to code, "message" to message))

                    override fun onDone(reason: String, payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("done", mapOf("reason" to reason))
                        if (reason == "awaiting_user_input" || reason == "phase_done") {
                            graphStateStore.applyAwaiting(payload)
                        }
                        val fullResponse = assistantBuilder.toString()
                        // Rebuild tool calls from steps: merge "started" and "ok" records by toolCallId
                        val steps = sessionStore.readSteps(handle)
                        val toolCallMap = linkedMapOf<String, Map<String, Any>>()
                        for (step in steps) {
                            val tcId = step["toolCallId"] as? String ?: continue
                            val existing = toolCallMap[tcId]
                            if (step["started"] == true) {
                                toolCallMap[tcId] = mapOf(
                                    "id" to tcId,
                                    "name" to (step["toolName"] ?: "unknown"),
                                    "status" to "running",
                                )
                            } else if (step["ok"] != null) {
                                val name = existing?.get("name") ?: "unknown"
                                toolCallMap[tcId] = mapOf(
                                    "id" to tcId,
                                    "name" to name,
                                    "status" to if (step["ok"] == true) "success" else "error",
                                )
                            }
                        }
                        val turnToolCalls = toolCallMap.values.toList()
                        if (fullResponse.isNotEmpty() || turnToolCalls.isNotEmpty()) {
                            val extra = mutableMapOf<String, Any?>()
                            if (turnToolCalls.isNotEmpty()) extra["toolCalls"] = turnToolCalls
                            sessionStore.appendMessage(handle, "assistant", fullResponse, extra.toMap())
                        }
                        sessionStore.updateMeta(handle) { meta ->
                            meta.running = false
                            meta.abnormalTermination = false
                        }
                        sessionStore.touchLastMessage(handle)
                        dispatchSessionList()
                    }

                    override fun onClosed() {
                        val isRunning = sessionHandle?.meta?.running == true
                        if (isRunning) {
                            sessionHandle?.let { h ->
                                sessionStore.updateMeta(h) { meta ->
                                    meta.running = false
                                    meta.abnormalTermination = true
                                }
                                val partialResponse = assistantBuilder.toString()
                                if (partialResponse.isNotEmpty()) {
                                    sessionStore.appendMessage(h, "assistant", partialResponse)
                                }
                                dispatchToWeb("session_interrupted", mapOf(
                                    "sessionId" to h.meta.id,
                                    "hasCheckpoint" to sessionStore.hasCheckpoint(h),
                                ))
                            }
                        }
                    }
                },
            )
        }
    }

    private fun handleRiskApproval(approved: Boolean) {
        log.info("Risk approval: $approved")
    }

    private fun handleNeedsInputResponse(payload: com.fasterxml.jackson.databind.JsonNode) {
        val handle = sessionHandle ?: run {
            log.warn("NeedsInputResponse: no active session handle")
            return
        }
        val sid = handle.meta.id
        val currentDispatcher = dispatcher ?: run {
            log.warn("NeedsInputResponse: no active ToolDispatcher")
            return
        }
        val currentGatherDispatcher = gatherDispatcher
        val currentGraphStateStore = graphStateStore ?: io.codepilot.plugin.tools.GraphStateStore(project, handle.dir)

        // Extract answers from WebUI payload
        // WebUI sends: {answers: [{questionId, optionId, freeform}], continuationToken: null}
        val answersNode = payload.path("answers")
        val answers: List<Map<String, Any?>> = if (answersNode.isArray && answersNode.size() > 0) {
            mapper.treeToValue(answersNode, List::class.java) as List<Map<String, Any?>>
        } else {
            // Fallback: single answer string
            val answerText = payload.path("answer").asText(null)
            if (answerText != null) listOf(mapOf("freeform" to answerText)) else emptyList()
        }

        // Get continuationToken from GraphStateStore (persisted by applyAwaiting from DONE event)
        val continuationToken = currentGraphStateStore.snapshot().path("continuationToken").asText(null)

        log.info("NeedsInputResponse: sessionId=$sid, continuationToken=$continuationToken, answersCount=${answers.size}")

        // Build resume payload using SessionStore (includes graphState, completedToolCalls, etc.)
        val userInput = answers.joinToString("; ") { a -> a["freeform"]?.toString() ?: a["optionId"]?.toString() ?: "" }
        val resumePayload = sessionStore.buildResumePayload(handle, userInput, handle.meta.modelId ?: "default")
        // Override with the actual answers and continuationToken from this response
        val fullPayload = resumePayload.toMutableMap()
        fullPayload["answers"] = answers
        fullPayload["intent"] = "answer"
        if (continuationToken != null) {
            fullPayload["continuationToken"] = continuationToken
        }

        // Call /v1/conversation/resume which triggers GraphEngine.resume()
        // Use the same listener pattern as the initial run to handle SSE events
        ApplicationManager.getApplication().executeOnPooledThread {
            val assistantBuilder = StringBuilder()
            // ★ Guard to prevent duplicate assistant message persistence on double done events
            var assistantPersisted = false
            client.resume(
                fullPayload.toMap(),
                object : ConversationClient.Listener {
                    override fun onDelta(text: String) {
                        assistantBuilder.append(text)
                        dispatchToWeb("delta", mapOf("text" to text))
                    }
                    override fun onToolCall(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("tool_call", data)
                        val toolName = payload.path("name").asText(null)
                        val toolCallId = payload.path("id").asText(null)
                        if (toolName != null && toolCallId != null) {
                            currentDispatcher.dispatch(payload)
                        }
                    }
                    override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))
                    override fun onGraphPlan(payload: com.fasterxml.jackson.databind.JsonNode) =
                        currentGraphStateStore.applyGraphPlan(payload)
                    override fun onGraphTransition(payload: com.fasterxml.jackson.databind.JsonNode) =
                        currentGraphStateStore.applyTransition(payload)
                    override fun onGraphInfoRequest(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val toolCallId = payload.path("toolCallId").asText("gather-batch")
                        currentGatherDispatcher?.dispatchBatch(payload.path("requests"), toolCallId)
                    }
                    override fun onDone(reason: String, payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("done", mapOf("reason" to reason))
                        if (reason == "awaiting_user_input" || reason == "phase_done") {
                            currentGraphStateStore.applyAwaiting(payload)
                        }
                    }
                    override fun onError(code: Int, message: String) =
                        dispatchToWeb("error", mapOf("code" to code, "message" to message))
                },
            )
        }
    }

    // ---- Session management ---- //

    fun handleNewSessionFromAction() {
        sessionHandle = null
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleNewSession() {
        sessionHandle = null
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleListSessions() {
        dispatchSessionList()
        // Also restore current session messages if a session is active
        dispatchCurrentSessionMessages()
    }

    private fun handleSwitchSession(sessionId: String) {
        val handle =
            sessionStore.resolve(workspaceHash, sessionId) ?: run {
                log.warn("Session not found: $sessionId")
                return
            }
        sessionHandle = handle
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleDeleteSession(sessionId: String) {
        val currentId = sessionHandle?.meta?.id
        if (currentId != null && sessionId == currentId) {
            // Deleting current session → reset to new (no disk session)
            sessionStore.delete(workspaceHash, sessionId)
            sessionHandle = null
        } else {
            sessionStore.delete(workspaceHash, sessionId)
        }
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleSessionPin(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { return }
        val pinned = payload.path("pinned").asBoolean(true)
        val handle = sessionStore.resolve(workspaceHash, id) ?: return
        sessionStore.updateMeta(handle) { it.pinned = pinned }
        if (sessionHandle?.meta?.id == id) sessionHandle = handle
        dispatchSessionList()
    }

    private fun handleSessionArchive(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { return }
        val archived = payload.path("archived").asBoolean(true)
        val handle = sessionStore.resolve(workspaceHash, id) ?: return
        sessionStore.updateMeta(handle) { it.archived = archived }
        if (sessionHandle?.meta?.id == id) sessionHandle = handle
        dispatchSessionList()
    }

    private fun handleSessionRename(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { return }
        val title = payload.path("title").asText("").ifBlank { return }
        val handle = sessionStore.resolve(workspaceHash, id) ?: return
        sessionStore.updateMeta(handle) { it.title = title.take(120) }
        if (sessionHandle?.meta?.id == id) sessionHandle = handle
        dispatchSessionList()
        dispatchCurrentSessionInfo()
    }

    private fun handleSessionSearch(payload: com.fasterxml.jackson.databind.JsonNode) {
        val query = payload.path("query").asText("")
        val includeArchived = payload.path("includeArchived").asBoolean(false)
        val results = sessionStore.list(workspaceHash)
            .filter { includeArchived || !it.archived }
            .mapNotNull { meta ->
                val h = sessionStore.resolve(workspaceHash, meta.id) ?: return@mapNotNull null
                val messages = sessionStore.readMessages(h)
                val preview = previewOf(messages)
                val haystack = listOf(meta.title ?: "", meta.mode, preview).joinToString("\n").lowercase()
                if (query.isBlank() || haystack.contains(query.lowercase())) sessionDto(h, messages) else null
            }
        dispatchToWeb("session.search.result", mapOf("query" to query, "sessions" to results))
    }

    private fun handleSessionDuplicate(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { return }
        val source = sessionStore.resolve(workspaceHash, id) ?: return
        val copy = sessionStore.newSession(workspaceHash, source.meta.mode, source.meta.modelId, source.meta.modelSource)
        sessionStore.readMessages(source).forEach {
            sessionStore.appendMessage(copy, it["role"] as? String ?: "user", it["content"] as? String ?: "")
        }
        sessionStore.updateMeta(copy) {
            it.title = "${source.meta.title ?: "Session"} (copy)"
        }
        sessionHandle = copy
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleForkFromMessage(messageIndex: Int) {
        val current = sessionHandle ?: return
        val actualIndex = if (messageIndex < 0) sessionStore.readMessages(current).lastIndex else messageIndex
        val forked = runCatching { sessionStore.forkFromMessage(current, actualIndex) }.getOrNull() ?: return
        sessionHandle = forked
        dispatchSessionList()
        dispatchBranchTree(current.meta.id)
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleBranchTree(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("sessionId").asText(sessionHandle?.meta?.id ?: "")
        dispatchBranchTree(id)
    }

    private fun handleVoiceStart() {
        io.codepilot.plugin.input.VoiceInputService.startRecording(project).thenAccept { transcript ->
            if (transcript.isNotBlank()) {
                dispatchToWeb("voice.result", mapOf("text" to transcript))
                dispatchToWeb("voice_result", mapOf("transcript" to transcript))
            }
        }
    }

    private fun handleVoiceStop() {
        io.codepilot.plugin.input.VoiceInputService.stopRecording(project)
    }

    private fun budgetBreakdown(
        rulesText: String,
        memoryText: String,
        contextRefs: List<Map<String, Any?>>,
        recentMessages: List<Map<String, Any?>>,
        totalUsed: Int,
    ): Map<String, Any?> {
        fun tokens(text: String): Int = io.codepilot.plugin.session.TokenEstimator.countTokens(text)
        fun item(id: String, label: String, count: Int, removable: Boolean) =
            mapOf("id" to id, "label" to label, "tokens" to count, "removable" to removable)
        val systemTokens = 1200
        val ruleTokens = tokens(rulesText)
        val memoryTokens = tokens(memoryText)
        val chipItems = contextRefs.mapIndexed { idx, ref ->
            val label = ref["display"]?.toString() ?: ref["filePath"]?.toString() ?: "context-${idx + 1}"
            item(ref["id"]?.toString() ?: label, label.take(80), tokens(label), true)
        }
        val historyItems = recentMessages.mapIndexed { idx, msg ->
            val content = msg["content"]?.toString() ?: ""
            item("msg-$idx", "${msg["role"] ?: "message"}: ${content.take(48)}", tokens(content), true)
        }
        val buckets = listOf(
            mapOf("kind" to "system", "tokens" to systemTokens, "items" to listOf(item("system", "System prompt", systemTokens, false))),
            mapOf("kind" to "rules", "tokens" to ruleTokens, "items" to if (ruleTokens > 0) listOf(item("rules", "Project rules", ruleTokens, false)) else emptyList()),
            mapOf("kind" to "memories", "tokens" to memoryTokens, "items" to if (memoryTokens > 0) listOf(item("memories", "Approved memories", memoryTokens, false)) else emptyList()),
            mapOf("kind" to "chips", "tokens" to chipItems.sumOf { it["tokens"] as Int }, "items" to chipItems),
            mapOf("kind" to "history", "tokens" to historyItems.sumOf { it["tokens"] as Int }, "items" to historyItems),
        )
        return mapOf("total" to 24000, "used" to totalUsed, "estimated" to 0, "buckets" to buckets)
    }

    private fun routeModel(
        requestedModelId: String?,
        text: String,
        mode: String,
        hasImages: Boolean,
        maxMode: Boolean,
    ): Map<String, Any?> {
        if (requestedModelId != null && requestedModelId != "auto" && !maxMode) {
            return mapOf("id" to requestedModelId, "source" to null, "tier" to tierFor(requestedModelId))
        }
        val desiredTier = when {
            maxMode -> "PREMIUM"
            mode == "inline-edit" -> "FAST"
            hasImages -> "THINKING"
            listOf("设计", "重构", "架构", "design", "refactor", "performance", "优化").any { text.contains(it, ignoreCase = true) } -> "THINKING"
            text.length < 80 -> "FAST"
            else -> "DEFAULT"
        }
        val candidates = modelCatalog.filter {
            val caps = it["capabilities"] as? Collection<*> ?: emptyList<Any>()
            (it["tier"] == desiredTier || (maxMode && it["tier"] == "PREMIUM")) &&
                (!hasImages || caps.contains("VISION"))
        }.ifEmpty {
            modelCatalog.filter { it["tier"] == "DEFAULT" }
        }.ifEmpty { modelCatalog }
        val chosen = candidates.firstOrNull() ?: return mapOf("id" to requestedModelId, "tier" to desiredTier)
        dispatchToWeb(
            "model.routed",
            mapOf("modelId" to chosen["id"], "name" to chosen["name"], "tier" to chosen["tier"], "reason" to if (maxMode) "Max mode" else "Auto: $desiredTier"),
        )
        eventBus.emit("system", "model-route-${System.nanoTime()}", io.codepilot.plugin.protocol.EventTypes.STEP_PROGRESS, mapOf("kind" to "model.routed", "model" to chosen))
        return chosen
    }

    private fun tierFor(modelId: String): String {
        val id = modelId.lowercase()
        return when {
            "haiku" in id || "flash" in id || "mini" in id || "fast" in id -> "FAST"
            "opus" in id || "max" in id || "gpt-5" in id -> "PREMIUM"
            "thinking" in id || "reason" in id || "sonnet" in id -> "THINKING"
            else -> "DEFAULT"
        }
    }

    private fun capabilitiesFor(modelId: String): List<String> {
        val id = modelId.lowercase()
        return buildList {
            add("TEXT")
            add("TOOL_USE")
            if ("vision" in id || "gpt-4" in id || "gpt-5" in id || "claude" in id) add("VISION")
            if ("json" in id || "gpt" in id || "claude" in id) add("JSON_MODE")
            if ("200k" in id || "256k" in id || "claude" in id) add("LONG_CTX_256K")
            if ("1m" in id || "gemini" in id) add("LONG_CTX_1M")
        }
    }

    private fun recordUsage(
        sessionId: String,
        turnId: String,
        modelId: String,
        tier: String,
        input: String,
        output: String,
    ) {
        val inputTokens = io.codepilot.plugin.session.TokenEstimator.countTokens(input)
        val outputTokens = io.codepilot.plugin.session.TokenEstimator.countTokens(output)
        val cost = ((inputTokens * 1.5) + (outputTokens * 5.0)) / 1_000_000.0
        usageRecords.add(
            mapOf(
                "ts" to System.currentTimeMillis(),
                "sessionId" to sessionId,
                "turnId" to turnId,
                "modelId" to modelId,
                "tier" to tier,
                "inputTokens" to inputTokens,
                "outputTokens" to outputTokens,
                "costUsd" to cost,
            ),
        )
        dispatchUsage()
    }

    private fun dispatchUsage() {
        fun day(ts: Long) = java.time.Instant.ofEpochMilli(ts).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()
        fun aggregate(key: (Map<String, Any?>) -> String): Map<String, Map<String, Any>> =
            usageRecords.groupBy(key).mapValues { (_, list) ->
                mapOf(
                    "count" to list.size,
                    "inputTokens" to list.sumOf { it["inputTokens"] as? Int ?: 0 },
                    "outputTokens" to list.sumOf { it["outputTokens"] as? Int ?: 0 },
                    "costUsd" to list.sumOf { it["costUsd"] as? Double ?: 0.0 },
                )
            }
        dispatchToWeb(
            "usage.update",
            mapOf(
                "byDay" to aggregate { day(it["ts"] as? Long ?: 0L) },
                "byModel" to aggregate { it["modelId"]?.toString() ?: "default" },
                "records" to usageRecords.takeLast(100),
            ),
        )
    }

    private fun handleUiNotify(payload: com.fasterxml.jackson.databind.JsonNode) {
        val title = payload.path("title").asText("CodePilot")
        val body = payload.path("body").asText("")
        com.intellij.notification.Notifications.Bus.notify(
            com.intellij.notification.Notification(
                "CodePilot",
                title,
                body,
                com.intellij.notification.NotificationType.INFORMATION,
            ),
            project,
        )
    }

    private fun dispatchSlashCommands() {
        val commands = loadTemplates().map {
            mapOf(
                "name" to (it["title"]?.toString()?.lowercase()?.replace(Regex("[^a-z0-9_-]+"), "-")?.trim('-') ?: "template"),
                "description" to "Template: ${it["title"] ?: "Untitled"}",
                "prompt" to (it["body"] ?: ""),
            )
        }
        dispatchToWeb("slash.commands.loaded", mapOf("commands" to commands))
    }

    private fun dispatchTemplates() {
        dispatchToWeb("templates.loaded", mapOf("templates" to loadTemplates()))
    }

    private fun handleTemplateSave(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("").ifBlank { "tpl-${System.currentTimeMillis()}" }
        val title = payload.path("title").asText("Untitled")
        val body = payload.path("body").asText("")
        val templates = loadTemplates().filterNot { it["id"] == id }.toMutableList()
        templates.add(mapOf("id" to id, "title" to title, "body" to body))
        saveTemplates(templates)
        dispatchTemplates()
        dispatchSlashCommands()
    }

    private fun handleTemplateDelete(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("")
        saveTemplates(loadTemplates().filterNot { it["id"] == id })
        dispatchTemplates()
        dispatchSlashCommands()
    }

    private fun templatesPath(): java.nio.file.Path =
        java.nio.file.Paths.get(project.basePath ?: ".").resolve(".codepilot").resolve("templates.json")

    private fun loadTemplates(): List<Map<String, Any?>> {
        val path = templatesPath()
        if (!java.nio.file.Files.exists(path)) return emptyList()
        return runCatching {
            val root = mapper.readTree(java.nio.file.Files.readString(path))
            val arr = if (root.isArray) root else root.path("templates")
            arr.map { node ->
                mapOf(
                    "id" to node.path("id").asText("tpl-${System.nanoTime()}"),
                    "title" to node.path("title").asText(node.path("name").asText("Untitled")),
                    "body" to node.path("body").asText(node.path("prompt").asText("")),
                )
            }
        }.getOrDefault(emptyList())
    }

    private fun saveTemplates(templates: List<Map<String, Any?>>) {
        val path = templatesPath()
        java.nio.file.Files.createDirectories(path.parent)
        java.nio.file.Files.writeString(path, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(mapOf("templates" to templates)))
    }

    private fun bgManager() = io.codepilot.plugin.background.BackgroundTaskManager.getInstance(project)

    private fun handleBgSubmit(payload: com.fasterxml.jackson.databind.JsonNode) {
        val title = payload.path("title").asText("")
        val prompt = payload.path("prompt").asText("").ifBlank { return }
        val result = runCatching { bgManager().submit(title, prompt) }
        result.onFailure { dispatchToWeb("bg.error", mapOf("message" to (it.message ?: "failed to submit background task"))) }
        handleBgList()
    }

    private fun handleBgList() {
        dispatchToWeb("bg.tasks.update", mapOf("tasks" to bgManager().list().map { task ->
            mapOf(
                "id" to task.id,
                "title" to task.title,
                "prompt" to task.prompt,
                "status" to task.status,
                "worktreePath" to task.worktreePath,
                "branchName" to task.branchName,
                "baseRef" to task.baseRef,
                "sessionId" to task.sessionId,
                "createdAt" to task.createdAt,
                "endedAt" to task.endedAt,
                "outputs" to mapOf(
                    "commits" to task.outputs.commits,
                    "diffStat" to task.outputs.diffStat,
                    "prUrl" to task.outputs.prUrl,
                    "logPath" to task.outputs.logPath,
                ),
            )
        }))
    }

    private fun handleBgCancel(payload: com.fasterxml.jackson.databind.JsonNode) {
        bgManager().cancel(payload.path("id").asText(""))
        handleBgList()
    }

    private fun handleBgMerge(payload: com.fasterxml.jackson.databind.JsonNode) {
        val result = bgManager().merge(payload.path("id").asText(""), payload.path("strategy").asText("squash"))
        dispatchToWeb("bg.action.result", result)
        handleBgList()
    }

    private fun handleBgDiscard(payload: com.fasterxml.jackson.databind.JsonNode) {
        val result = bgManager().discard(payload.path("id").asText(""))
        dispatchToWeb("bg.action.result", result)
        handleBgList()
    }

    private fun handleBgOpenWorktree(payload: com.fasterxml.jackson.databind.JsonNode) {
        dispatchToWeb("bg.action.result", bgManager().openWorktree(payload.path("id").asText("")))
    }

    private fun exportFormat(raw: String): io.codepilot.plugin.export.ExportService.Format =
        when (raw.lowercase()) {
            "json" -> io.codepilot.plugin.export.ExportService.Format.JSON
            "pr_description", "pr" -> io.codepilot.plugin.export.ExportService.Format.PR_DESCRIPTION
            else -> io.codepilot.plugin.export.ExportService.Format.MARKDOWN
        }

    private fun handleExportPreview(payload: com.fasterxml.jackson.databind.JsonNode) {
        val sessionId = payload.path("sessionId").asText(sessionHandle?.meta?.id ?: "")
        val format = exportFormat(payload.path("format").asText("markdown"))
        val includeTools = payload.path("includeTools").asBoolean(true)
        val result = runCatching {
            io.codepilot.plugin.export.ExportService.getInstance(project).export(sessionId, format, includeTools)
        }
        dispatchToWeb(
            "export.preview.result",
            result.fold(
                onSuccess = { mapOf("ok" to true, "content" to it, "format" to format.name.lowercase()) },
                onFailure = { mapOf("ok" to false, "error" to (it.message ?: "export failed")) },
            ),
        )
    }

    private fun handleExportSave(payload: com.fasterxml.jackson.databind.JsonNode) {
        val sessionId = payload.path("sessionId").asText(sessionHandle?.meta?.id ?: "")
        val format = exportFormat(payload.path("format").asText("markdown"))
        val includeTools = payload.path("includeTools").asBoolean(true)
        val path = payload.path("path").asText("")
        val result = runCatching {
            io.codepilot.plugin.export.ExportService.getInstance(project).save(sessionId, format, path, includeTools)
        }
        dispatchToWeb(
            "export.save.result",
            result.getOrElse { mapOf("ok" to false, "error" to (it.message ?: "save failed")) },
        )
    }

    private fun handleShareCreate(payload: com.fasterxml.jackson.databind.JsonNode) {
        val sessionId = payload.path("sessionId").asText(sessionHandle?.meta?.id ?: "")
        val title = sessionHandle?.meta?.title ?: "CodePilot Share"
        val content = runCatching {
            io.codepilot.plugin.export.ExportService.getInstance(project).export(
                sessionId,
                io.codepilot.plugin.export.ExportService.Format.MARKDOWN,
                includeTools = false,
            )
        }.getOrElse {
            dispatchToWeb("share.create.result", mapOf("ok" to false, "error" to (it.message ?: "export failed")))
            return
        }
        val remote = runCatching {
            val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
            val req = http.postJson(
                "/v1/share/create",
                mapOf("title" to title, "format" to "markdown", "content" to content, "expireDays" to payload.path("expireDays").asInt(7)),
            )
            http.client().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("share service failed: HTTP ${resp.code}")
                val body = resp.body?.string() ?: "{}"
                val data = mapper.readTree(body).path("data")
                mapOf("ok" to true, "url" to data.path("url").asText(""), "shareId" to data.path("shareId").asText(""))
            }
        }
        val result = remote.getOrElse {
            val dir = java.nio.file.Paths.get(project.basePath ?: ".").resolve(".codepilot").resolve("share")
            java.nio.file.Files.createDirectories(dir)
            val target = dir.resolve("${sessionId}-${System.currentTimeMillis()}.md")
            java.nio.file.Files.writeString(target, content)
            mapOf("ok" to true, "url" to target.toUri().toString(), "path" to target.toString(), "fallback" to "local-file")
        }
        dispatchToWeb("share.create.result", result)
    }

    /** Push the full session list (sorted by lastMessageAt desc) to the WebUI. */
    private fun dispatchSessionList() {
        val sessions =
            sessionStore
                .list(workspaceHash)
                .sortedByDescending { it.lastMessageAt ?: it.createdAt }
                .mapNotNull { meta ->
                    val handle = sessionStore.resolve(workspaceHash, meta.id) ?: return@mapNotNull null
                    sessionDto(handle, sessionStore.readMessages(handle))
                }
        dispatchToWeb("session_list", mapOf("sessions" to sessions, "activeSessionId" to (sessionHandle?.meta?.id ?: "")))
        sessionHandle?.meta?.id?.let { dispatchBranchTree(it) }
    }

    private fun sessionDto(
        handle: io.codepilot.plugin.session.SessionStore.SessionHandle,
        messages: List<Map<String, Any>>,
    ): Map<String, Any?> {
        val meta = handle.meta
        return mapOf(
            "id" to meta.id,
            "title" to (meta.title ?: "New Chat"),
            "mode" to meta.mode,
            "createdAt" to meta.createdAt,
            "updatedAt" to meta.updatedAt,
            "lastMessageAt" to meta.lastMessageAt,
            "messageCount" to messages.size,
            "pinned" to meta.pinned,
            "archived" to meta.archived,
            "preview" to previewOf(messages),
            "branches" to branchDtos(handle),
        )
    }

    private fun previewOf(messages: List<Map<String, Any>>): String =
        messages.firstOrNull { it["role"] == "user" }?.get("content")?.toString()?.take(120) ?: ""

    private fun branchDtos(handle: io.codepilot.plugin.session.SessionStore.SessionHandle): List<Map<String, Any?>> =
        sessionStore.listBranches(handle).map {
            val branchHandle = sessionStore.resolve(workspaceHash, it.sessionId)
            val messageCount = branchHandle?.let { h -> sessionStore.readMessages(h).size } ?: 0
            mapOf(
                "branchId" to it.branchId,
                "sessionId" to it.sessionId,
                "parentBranchId" to it.parentBranchId,
                "forkMsgIndex" to it.forkMsgIndex,
                "title" to (branchHandle?.meta?.title ?: it.branchId),
                "createdAt" to (branchHandle?.meta?.createdAt ?: ""),
                "messageCount" to messageCount,
                "active" to (sessionHandle?.meta?.id == it.sessionId),
            )
        }

    private fun dispatchBranchTree(sessionId: String) {
        val handle = sessionStore.resolve(workspaceHash, sessionId) ?: sessionHandle ?: return
        dispatchToWeb("branch.tree.result", mapOf("sessionId" to sessionId, "branches" to branchDtos(handle)))
    }

    /** Push current session metadata. */
    private fun dispatchCurrentSessionInfo() {
        val meta = sessionHandle?.meta
        if (meta != null) {
            dispatchToWeb(
                "session_switched",
                mapOf(
                    "id" to meta.id,
                    "title" to (meta.title ?: "New Chat"),
                    "mode" to meta.mode,
                    "createdAt" to meta.createdAt,
                    "lastMessageAt" to meta.lastMessageAt,
                ),
            )
        } else {
            // No active session — inform WebUI it's a fresh new chat
            dispatchToWeb(
                "session_switched",
                mapOf(
                    "id" to "",
                    "title" to "New Chat",
                    "mode" to "agent",
                    "createdAt" to "",
                    "lastMessageAt" to null as Any?,
                ),
            )
        }
    }

    /** Push all messages of the current session so the WebUI can restore the chat view. */
    private fun dispatchCurrentSessionMessages() {
        val handle = sessionHandle
        if (handle != null) {
            // Load completed steps to rebuild toolCalls for each assistant message
            val steps = sessionStore.readSteps(handle)
            val messages =
                sessionStore.readMessages(handle).map { msg ->
                    val m = mutableMapOf<String, Any?>(
                        "role" to (msg["role"] ?: "unknown"),
                        "content" to (msg["content"] ?: ""),
                    )
                    // Preserve contextRefs if present
                    if (msg["contextRefs"] != null) m["contextRefs"] = msg["contextRefs"]
                    // Preserve toolCall info if present
                    if (msg["toolCall"] != null) m["toolCall"] = msg["toolCall"]
                    // Preserve ts (timestamp) for display
                    if (msg["ts"] != null) m["ts"] = msg["ts"]
                    // Restore toolCalls from persisted data or rebuild from steps
                    if (msg["toolCalls"] != null) {
                        m["toolCalls"] = msg["toolCalls"]
                    } else if (msg["role"] == "assistant" && steps.isNotEmpty()) {
                        // Rebuild toolCalls from step records: merge "started" and "ok" records
                        val toolCallMap = linkedMapOf<String, Map<String, Any>>()
                        for (step in steps) {
                            val tcId = step["toolCallId"] as? String ?: continue
                            if (step["started"] == true) {
                                toolCallMap[tcId] = mapOf(
                                    "id" to tcId,
                                    "name" to (step["toolName"] ?: "unknown"),
                                    "args" to emptyMap<String, Any>(),
                                    "status" to "success",
                                )
                            } else if (step["ok"] != null) {
                                val existing = toolCallMap[tcId]
                                val name = existing?.get("name") ?: "unknown"
                                val args = existing?.get("args") ?: emptyMap<String, Any>()
                                toolCallMap[tcId] = mapOf(
                                    "id" to tcId,
                                    "name" to name,
                                    "args" to args,
                                    "status" to if (step["ok"] == true) "success" else "error",
                                )
                            }
                        }
                        val toolCalls = toolCallMap.values.toList()
                        if (toolCalls.isNotEmpty()) m["toolCalls"] = toolCalls
                    }
                    m.toMap()
                }
            dispatchToWeb("session_messages", mapOf(
                "sessionId" to handle.meta.id,
                "messages" to messages,
                "abnormalTermination" to (handle.meta.abnormalTermination ?: false),
                "hasCheckpoint" to sessionStore.hasCheckpoint(handle),
            ))
        } else {
            dispatchToWeb("session_messages", mapOf("sessionId" to "", "messages" to emptyList<Map<String, Any?>>(), "abnormalTermination" to false, "hasCheckpoint" to false))
        }
    }

    private fun resolveWebUiPath(): String {
        // In production, the built webui is bundled inside the plugin jar/resources.
        // JCEF cannot load jar:file:// URLs, so we extract to a temp directory.
        val resourceUrl = javaClass.getResource("/webui/dist/index.html")
        if (resourceUrl != null) {
            val extractDir = extractWebUiToTemp()
            return extractDir.resolve("index.html").toUri().toString()
        }
        // Dev fallback: load from the source directory
        val devPath = Path.of(project.basePath ?: ".", "plugin", "webui", "dist", "index.html")
        if (devPath.toFile().exists()) {
            return devPath.toUri().toString()
        }
        // WebUI not built — throw to signal fallback to Swing panel
        throw IllegalStateException("WebUI not found. Run 'cd plugin/webui && npm run build' first, or use Swing panel fallback.")
    }

    /**
     * Extracts /webui/dist/ resources from the plugin JAR to a temp directory
     * so JCEF can load them via file:// protocol.
     */
    private fun extractWebUiToTemp(): Path {
        val tempDir =
            java.nio.file.Files
                .createTempDirectory("codepilot-webui")
        // Register cleanup on JVM exit
        Runtime.getRuntime().addShutdownHook(
            Thread {
                tempDir.toFile().deleteRecursively()
            },
        )

        val classLoader = javaClass.classLoader
        // Walk known resource paths — enumerate from the index.html and assets
        copyResourceToTemp(classLoader, "/webui/dist/index.html", tempDir.resolve("index.html"))

        // Copy assets directory — we need to discover files from the JAR
        val jarUrl = javaClass.getResource("/webui/dist/index.html")!!
        val protocol = jarUrl.protocol
        if (protocol == "jar") {
            val jarPath = jarUrl.path.substringBefore("!")
            val jarFile = java.util.jar.JarFile(java.io.File(java.net.URI(jarPath)))
            jarFile.use { jar ->
                jar
                    .entries()
                    .asSequence()
                    .filter { it.name.startsWith("webui/dist/") && !it.isDirectory }
                    .forEach { entry ->
                        val relativePath = entry.name.removePrefix("webui/dist/")
                        val targetFile = tempDir.resolve(relativePath)
                        java.nio.file.Files
                            .createDirectories(targetFile.parent)
                        jar.getInputStream(entry).use { input ->
                            java.nio.file.Files
                                .copy(input, targetFile, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                        }
                    }
            }
        } else {
            // Non-jar (e.g., file:// in dev mode with exploded classes)
            val baseDir = Path.of(jarUrl.toURI()).parent
            baseDir.toFile().walkTopDown().filter { it.isFile }.forEach { file ->
                val rel = baseDir.relativize(file.toPath())
                val target = tempDir.resolve(rel)
                java.nio.file.Files
                    .createDirectories(target.parent)
                java.nio.file.Files
                    .copy(file.toPath(), target, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            }
        }
        return tempDir
    }

    private fun copyResourceToTemp(
        classLoader: ClassLoader,
        resourcePath: String,
        target: Path,
    ) {
        val input = classLoader.getResourceAsStream(resourcePath.removePrefix("/")) ?: return
        java.nio.file.Files
            .createDirectories(target.parent)
        input.use {
            java.nio.file.Files
                .copy(it, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        }
    }

    // ---- Auth handlers for login page ----

    private fun handleCheckAuth() {
        val hasToken = settings.accessToken() != null
        val hasRefreshToken = settings.refreshToken() != null
        val hasDevToken = settings.state.devToken.isNotBlank()
        log.info(
            "[Auth] checkAuth: hasToken=$hasToken, hasRefreshToken=$hasRefreshToken, hasDevToken=$hasDevToken, devToken=${if (hasDevToken) {
                settings.state.devToken.take(
                    8,
                ) + "..."
            } else {
                "null"
            }}, baseUrl=${settings.state.backendBaseUrl}",
        )

        // Dev token: no expiry, trust immediately
        if (hasDevToken) {
            dispatchToWeb("auth_state", mapOf("authenticated" to true))
            handleFetchModels()
            return
        }

        // No tokens at all → not authenticated
        if (!hasToken && !hasRefreshToken) {
            dispatchToWeb("auth_state", mapOf("authenticated" to false))
            return
        }

        // We have an access token and/or refresh token.
        // Validate by trying to fetch models — if the access token is expired,
        // RefreshOn401Interceptor will attempt a silent refresh first.
        // Report authenticated=true optimistically; if refresh fails later,
        // the interceptor will dispatch auth_state=false.
        dispatchToWeb("auth_state", mapOf("authenticated" to true))
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val refreshNeeded = hasRefreshToken && !hasToken
                if (refreshNeeded) {
                    // Access token is gone but refresh token exists — proactively refresh
                    log.info("[Auth] checkAuth: access token missing, attempting refresh...")
                    val refreshed = runCatching {
                        io.codepilot.plugin.auth.AuthService.getInstance().refresh().get()
                    }.getOrNull() == true
                    if (!refreshed) {
                        log.warn("[Auth] checkAuth: refresh failed, showing login page")
                        settings.setAccessToken(null)
                        settings.setRefreshToken(null)
                        settings.setDeviceSecret(null)
                        dispatchToWeb("auth_state", mapOf("authenticated" to false))
                        return@executeOnPooledThread
                    }
                }
                handleFetchModels()
            } catch (e: Exception) {
                log.error("[Auth] checkAuth: error during validation", e)
            }
        }
    }

    private fun handleAuthDiscover() {
        val baseUrl = settings.state.backendBaseUrl.trimEnd('/')
        log.info("[Auth] Discover: baseUrl=$baseUrl")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val auth =
                    io.codepilot.plugin.auth.AuthService
                        .getInstance()
                auth.fetchMethods().whenComplete { result, err ->
                    if (err != null) {
                        log.error("[Auth] Discover failed", err)
                        dispatchToWeb(
                            "auth_methods",
                            mapOf(
                                "oidc" to false,
                                "hmacBridge" to false,
                                "dev" to false,
                                "deviceFlow" to false,
                            ),
                        )
                    } else {
                        val m =
                            result.data ?: io.codepilot.plugin.auth.AuthService
                                .Methods()
                        log.info(
                            "[Auth] Discover success: oidc=${m.oidc}, hmacBridge=${m.hmacBridge}, dev=${m.dev}, deviceFlow=${m.deviceFlow}",
                        )
                        dispatchToWeb(
                            "auth_methods",
                            mapOf(
                                "oidc" to m.oidc,
                                "hmacBridge" to m.hmacBridge,
                                "dev" to m.dev,
                                "deviceFlow" to m.deviceFlow,
                            ),
                        )
                    }
                }
            } catch (e: Exception) {
                log.error("[Auth] Discover exception", e)
                dispatchToWeb(
                    "auth_methods",
                    mapOf(
                        "oidc" to false,
                        "hmacBridge" to false,
                        "dev" to false,
                        "deviceFlow" to false,
                    ),
                )
            }
        }
    }

    private fun handleAuthLoginBridge(token: String) {
        log.info("[Auth] Bridge login attempt, token length=${token.length}")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val auth =
                    io.codepilot.plugin.auth.AuthService
                        .getInstance()
                auth.login(token).whenComplete { _, err ->
                    if (err != null) {
                        log.error("[Auth] Bridge login failed", err)
                        dispatchToWeb("auth_login_result", mapOf("success" to false, "error" to (err.message ?: "unknown")))
                    } else {
                        log.info("[Auth] Bridge login success")
                        dispatchToWeb("auth_login_result", mapOf("success" to true))
                        dispatchToWeb("auth_state", mapOf("authenticated" to true))
                    }
                }
            } catch (e: Exception) {
                log.error("[Auth] Bridge login exception", e)
                dispatchToWeb("auth_login_result", mapOf("success" to false, "error" to (e.message ?: "unknown")))
            }
        }
    }

    private fun handleAuthLoginDev(
        token: String,
        userId: String,
        tenantId: String,
    ) {
        log.info("[Auth] Dev login attempt: userId=$userId, tenantId=$tenantId")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val loginService =
                    io.codepilot.plugin.auth.LoginService
                        .getInstance()
                val deviceId = settings.state.deviceId
                loginService.devLogin(token, userId, tenantId, deviceId).whenComplete { _, err ->
                    if (err != null) {
                        log.error("[Auth] Dev login failed", err)
                        dispatchToWeb("auth_login_result", mapOf("success" to false, "error" to (err.message ?: "unknown")))
                    } else {
                        log.info("[Auth] Dev login success")
                        dispatchToWeb("auth_login_result", mapOf("success" to true))
                        dispatchToWeb("auth_state", mapOf("authenticated" to true))
                    }
                }
            } catch (e: Exception) {
                log.error("[Auth] Dev login exception", e)
                dispatchToWeb("auth_login_result", mapOf("success" to false, "error" to (e.message ?: "unknown")))
            }
        }
    }

    private fun handleAuthLoginOidc() {
        log.info("[Auth] OIDC login attempt")
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val loginService =
                    io.codepilot.plugin.auth.LoginService
                        .getInstance()
                val flow = loginService.startOidc()
                flow.asFuture().whenComplete { _, err ->
                    if (err != null) {
                        log.error("[Auth] OIDC login failed", err)
                        dispatchToWeb("auth_login_result", mapOf("success" to false, "error" to (err.message ?: "unknown")))
                    } else {
                        log.info("[Auth] OIDC login success")
                        dispatchToWeb("auth_login_result", mapOf("success" to true))
                        dispatchToWeb("auth_state", mapOf("authenticated" to true))
                    }
                }
            } catch (e: Exception) {
                log.error("[Auth] OIDC login exception", e)
                dispatchToWeb("auth_login_result", mapOf("success" to false, "error" to (e.message ?: "unknown")))
            }
        }
    }

    // ---- @-reference and patch event handlers ----

    /**
     * ★ at_suggest: Returns a list of @-reference candidates for the given query.
     * Supports @file, @folder, @symbol, @terminal, @git, @codebase, @docs, @web patterns.
     * Delegates to AtReferenceProvider for comprehensive results.
     */
    private fun handleAtSuggest(query: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val refProvider = io.codepilot.plugin.context.AtReferenceProvider.getInstance(project)
            val rawSuggestions = refProvider.suggest(query, limit = 20)

            // Map AtReferenceProvider.Suggestion to the webui format: {id, type, label, detail, path}
            val suggestions = rawSuggestions.map { s ->
                // Extract the value part from label: "@file path" -> "path", "@git diff" -> "diff"
                val valueFromLabel = s.label.removePrefix("@").removePrefix(s.type).trim()
                val effectivePath = s.path ?: valueFromLabel
                mapOf(
                    "id" to "${s.type}:${effectivePath}",
                    "type" to s.type,
                    "label" to s.label,
                    "detail" to s.detail,
                    "path" to effectivePath,
                )
            }
            dispatchToWeb("at_suggestions", mapOf("query" to query, "suggestions" to suggestions))
        }
    }

    /**
     * ★ at_resolve: Resolves an @-reference ID to its full content.
     * Delegates to AtReferenceProvider for comprehensive resolution.
     * Stores resolved content in contextStore for later inclusion in messages.
     * Returns: {id, type, display, path, content, chipId} to the webui.
     */
    private fun handleAtResolve(id: String, chipId: String?) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val parts = id.split(":", limit = 2)
            if (parts.size < 2) {
                dispatchToWeb("at_resolved", mapOf("id" to id, "content" to "", "error" to "invalid reference format, expected type:value"))
                return@executeOnPooledThread
            }
            val (type, value) = parts[0] to parts[1]

            val refProvider = io.codepilot.plugin.context.AtReferenceProvider.getInstance(project)
            val result = refProvider.resolve(type, value)

            if (result == null) {
                dispatchToWeb("at_resolved", mapOf("id" to id, "type" to type, "content" to "", "error" to "Could not resolve @$type $value"))
            } else {
                // Store the resolved content in contextStore so it's available for the next message
                val storeId = chipId ?: id
                contextStore[storeId] = result.content

                dispatchToWeb("at_resolved", mapOf(
                    "id" to id,
                    "type" to result.type,
                    "display" to result.display,
                    "path" to (result.path ?: ""),
                    "content" to result.content,
                    "chipId" to (chipId ?: ""),
                ))
            }
        }
    }

    /**
     * ★ apply_patches: Apply all patches from the SSE stream (full-file diff approval).
     */
    private fun handleApplyPatches(payload: com.fasterxml.jackson.databind.JsonNode) {
        val patchApplier =
            io.codepilot.plugin.tools
                .PatchApplier(project)
        val patches = payload.path("patches")
        if (patches.isArray && patches.size() > 0) {
            patchApplier.applyAll(patches)
        } else {
            val patchText = payload.path("patch").asText("")
            if (patchText.isNotBlank()) {
                patchApplier.applyUnifiedPatch(patchText)
            }
        }
    }

    /**
     * ★ Integration: apply_code_block — Single code block Apply button from Chat.
     * Delegates to ApplyCodeAction.applyCodeBlock() for file write/create.
     */
    private fun handleApplyCodeBlock(payload: com.fasterxml.jackson.databind.JsonNode) {
        val code = payload.path("code").asText("")
        val language = payload.path("language").asText("")
        val filePath = payload.path("filePath").asText(null)
        if (code.isNotBlank()) {
            io.codepilot.plugin.actions.ApplyCodeAction.applyCodeBlock(project, code, language, filePath)
        }
    }

    /**
     * ★ Integration: Bug scan — Collect IDE diagnostics via BugScanService
     * and send them back to the chat for the Agent to process.
     */
    private fun handleBugScan(payload: com.fasterxml.jackson.databind.JsonNode) {
        val filePath = payload.path("filePath").asText(null)
        val bugScan = io.codepilot.plugin.tools.BugScanService(project)
        val result = if (filePath != null) {
            bugScan.scanFile(filePath)
        } else {
            bugScan.scanOpenFiles()
        }
        // Send scan results back to the chat as a context message
        val diagnosticsText = result.diagnostics.joinToString("\n") { d ->
            "[${d.severity}] ${d.filePath}:${d.line} — ${d.message} (source: ${d.source})"
        }
        dispatchToWeb("bug_scan_result", mapOf(
            "diagnostics" to result.diagnostics.map { mapOf(
                "file" to it.filePath, "line" to it.line,
                "severity" to it.severity, "message" to it.message, "source" to it.source
            )},
            "fileCount" to result.fileCount,
            "durationMs" to result.durationMs,
        ))
    }

    /**
     * ★ apply_selected_hunks: Apply only selected hunks from a unified diff.
     */
    private fun handleApplySelectedHunks(payload: com.fasterxml.jackson.databind.JsonNode) {
        val patchText = payload.path("patch").asText("")
        val selectedHunks =
            payload
                .path("selectedHunks")
                .takeIf { it.isArray }
                ?.map { it.asInt() }
                ?.toSet()
                ?: emptySet()
        if (patchText.isNotBlank() && selectedHunks.isNotEmpty()) {
            val patchApplier =
                io.codepilot.plugin.tools
                    .PatchApplier(project)
            patchApplier.applySelectedHunks(patchText, selectedHunks)
        }
    }

    // ---- Plan edit handlers for Agent mode ----

    /**
     * ★ plan_edit: Edit a plan step (skip/edit/add).
     * Payload: { op: 'skip'|'edit'|'add', stepId, title?, intent? }
     */
    private fun handlePlanEdit(payload: com.fasterxml.jackson.databind.JsonNode) {
        val op = payload.path("op").asText("") ?: return
        val stepId = payload.path("stepId").asText("") ?: return
        val handle = sessionHandle ?: return

        when (op) {
            "skip" -> {
                // Mark step as skipped via plan_delta dispatch
                dispatchToWeb(
                    "plan_delta",
                    mapOf(
                        "ops" to listOf(mapOf("op" to "skip", "stepId" to stepId)),
                    ),
                )
                sessionStore.savePlanDelta(handle, mapOf("ops" to listOf(mapOf("op" to "skip", "stepId" to stepId))))
            }
            "edit" -> {
                val title = payload.path("title").asText(null)
                val intent = payload.path("intent").asText(null)
                // Dispatch edit delta to update the step
                val editOp = mutableMapOf<String, Any?>("op" to "edit", "stepId" to stepId)
                if (title != null) editOp["title"] = title
                if (intent != null) editOp["intent"] = intent
                dispatchToWeb("plan_delta", mapOf("ops" to listOf(editOp)))
                sessionStore.savePlanDelta(handle, mapOf("ops" to listOf(editOp)))
            }
            "add" -> {
                val title = payload.path("title").asText("New step")
                val intent = payload.path("intent").asText("")
                val newStep =
                    mapOf(
                        "op" to "add",
                        "id" to stepId,
                        "title" to title,
                        "intent" to intent,
                        "status" to "pending",
                    )
                dispatchToWeb("plan_delta", mapOf("ops" to listOf(newStep)))
                sessionStore.savePlanDelta(handle, mapOf("ops" to listOf(newStep)))
            }
            else -> log.warn("Unknown plan_edit op: $op")
        }
    }

    /**
     * ★ continue_run: Resume AgentLoop execution after user edit/approval.
     */
    private fun handleContinueRun() {
        val sid = sessionHandle?.meta?.id ?: return
        log.info("[Plan] continue_run: resuming agent loop for session $sid")
        // Resume the conversation with intent=continue
        val handle = sessionHandle ?: return
        val graphStateStore =
            io.codepilot.plugin.tools
                .GraphStateStore(project, handle.dir)
        graphStateStore.loadLatest()
        if (graphStateStore.isAwaiting()) {
            val payload =
                mapOf(
                    "sessionId" to sid,
                    "mode" to (handle.meta.mode ?: "agent"),
                    "input" to "",
                    "intent" to "continue",
                    "graphState" to graphStateStore.snapshot(),
                )
            ApplicationManager.getApplication().executeOnPooledThread {
                client.run(
                    payload,
                    object : ConversationClient.Listener {
                        override fun onDelta(text: String) = dispatchToWeb("delta", mapOf("text" to text))

                        override fun onToolCall(p: com.fasterxml.jackson.databind.JsonNode) =
                            dispatchToWeb("tool_call", mapper.treeToValue(p, Map::class.java))

                        override fun onPlan(p: com.fasterxml.jackson.databind.JsonNode) {
                            val data = mapper.treeToValue(p, Map::class.java)
                            dispatchToWeb("plan", data)
                            sessionStore.savePlan(handle, data)
                        }

                        override fun onPlanDelta(p: com.fasterxml.jackson.databind.JsonNode) =
                            dispatchToWeb("plan_delta", mapper.treeToValue(p, Map::class.java))

                        override fun onTaskLedger(p: com.fasterxml.jackson.databind.JsonNode) {
                            val data = mapper.treeToValue(p, Map::class.java)
                            dispatchToWeb("task_ledger", data)
                            sessionStore.saveLedger(handle, data)
                        }

                        override fun onRiskNotice(p: com.fasterxml.jackson.databind.JsonNode) =
                            dispatchToWeb("risk_notice", mapper.treeToValue(p, Map::class.java))

                        override fun onNeedsInput(p: com.fasterxml.jackson.databind.JsonNode) =
                            dispatchToWeb("needs_input", mapper.treeToValue(p, Map::class.java))

                        override fun onGraphPlan(p: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyGraphPlan(p)

                        override fun onGraphTransition(p: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyTransition(p)

                        override fun onGraphInfoRequest(p: com.fasterxml.jackson.databind.JsonNode) {}

                        override fun onGraphInfoResult(p: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyInfoResult(p)

                        override fun onGraphVerify(p: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyVerify(p)

                        override fun onGraphRepairPlan(p: com.fasterxml.jackson.databind.JsonNode) {}

                        override fun onGraphPhaseDone(p: com.fasterxml.jackson.databind.JsonNode) = graphStateStore.applyPhaseDone(p)

                        override fun onGraphBudgetAlert(p: com.fasterxml.jackson.databind.JsonNode) {}

                        override fun onUserPlan(p: com.fasterxml.jackson.databind.JsonNode) =
                            dispatchToWeb("user_plan", mapper.treeToValue(p, Map::class.java))

                        override fun onUserPlanProgress(p: com.fasterxml.jackson.databind.JsonNode) =
                            dispatchToWeb("user_plan_progress", mapper.treeToValue(p, Map::class.java))

                        override fun onError(
                            code: Int,
                            message: String,
                        ) = dispatchToWeb("error", mapOf("code" to code, "message" to message))

                        override fun onDone(
                            reason: String,
                            p: com.fasterxml.jackson.databind.JsonNode,
                        ) {
                            dispatchToWeb("done", mapOf("reason" to reason))
                            if (reason == "awaiting_user_input" || reason == "phase_done") {
                                graphStateStore.applyAwaiting(p)
                            }
                            sessionStore.touchLastMessage(handle)
                            dispatchSessionList()
                        }

                        override fun onClosed() {}
                    },
                )
            }
        } else {
            log.warn("[Plan] continue_run: no awaiting graph state, nothing to resume")
        }
    }

    /**
     * ★ replan: Trigger re-planning from the current state.
     */
    private fun handleReplan() {
        val sid = sessionHandle?.meta?.id ?: return
        log.info("[Plan] replan: triggering re-plan for session $sid")
        val handle = sessionHandle ?: return
        val payload =
            mapOf(
                "sessionId" to sid,
                "mode" to (handle.meta.mode ?: "agent"),
                "input" to "replan",
                "intent" to "replan",
            )
        ApplicationManager.getApplication().executeOnPooledThread {
            client.run(
                payload,
                object : ConversationClient.Listener {
                    override fun onDelta(text: String) = dispatchToWeb("delta", mapOf("text" to text))

                    override fun onToolCall(p: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("tool_call", mapper.treeToValue(p, Map::class.java))

                    override fun onPlan(p: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(p, Map::class.java)
                        dispatchToWeb("plan", data)
                        sessionStore.savePlan(handle, data)
                    }

                    override fun onPlanDelta(p: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("plan_delta", mapper.treeToValue(p, Map::class.java))

                    override fun onTaskLedger(p: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(p, Map::class.java)
                        dispatchToWeb("task_ledger", data)
                        sessionStore.saveLedger(handle, data)
                    }

                    override fun onRiskNotice(p: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("risk_notice", mapper.treeToValue(p, Map::class.java))

                    override fun onNeedsInput(p: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("needs_input", mapper.treeToValue(p, Map::class.java))

                    override fun onGraphPlan(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphTransition(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphInfoRequest(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphInfoResult(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphVerify(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphRepairPlan(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphPhaseDone(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onGraphBudgetAlert(p: com.fasterxml.jackson.databind.JsonNode) {}

                    override fun onUserPlan(p: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan", mapper.treeToValue(p, Map::class.java))

                    override fun onUserPlanProgress(p: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan_progress", mapper.treeToValue(p, Map::class.java))

                    override fun onError(
                        code: Int,
                        message: String,
                    ) = dispatchToWeb("error", mapOf("code" to code, "message" to message))

                    override fun onDone(
                        reason: String,
                        p: com.fasterxml.jackson.databind.JsonNode,
                    ) {
                        dispatchToWeb("done", mapOf("reason" to reason))
                        sessionStore.touchLastMessage(handle)
                        dispatchSessionList()
                    }

                    override fun onClosed() {}
                },
            )
        }
    }

    private fun handleUpdateAutoApply(payload: JsonNode) {
        val enabled = payload["enabled"]?.asBoolean() ?: return
        val settings = CodePilotSettings.getInstance()
        settings.state.autoApplyLowRiskPatches = enabled
        log.info("[Settings] Updated autoApplyLowRiskPatches to $enabled")
        // Sync back to web UI
        dispatchToWeb("auto_apply_state", mapOf("enabled" to enabled))
    }
}