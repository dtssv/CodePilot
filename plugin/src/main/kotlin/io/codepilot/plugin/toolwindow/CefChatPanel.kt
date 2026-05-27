package io.codepilot.plugin.toolwindow

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import io.codepilot.plugin.conversation.ConversationClient
import io.codepilot.plugin.context.InlineContextExpander
import io.codepilot.plugin.context.buildProjectMetaSnippet
import io.codepilot.plugin.protocol.TerminalDoneReasons
import io.codepilot.plugin.session.SessionStore
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.settings.LocaleHelper
import io.codepilot.plugin.tools.ToolDispatcher
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
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
) : Disposable, QuickActionChatSink {
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

    /** Bumped when starting a new chat / switching session so stale SSE callbacks are ignored. */
    private var activeStreamGeneration = 0

    /** When set, matching {@link #onClosed} must not mark session interrupted (rate limit). */
    private var rateLimitedStreamGen = -1

    /** P2b durable run id from {@code run_started} (survives rolling deploy). */
    private var durableRunId: String? = null
    private var durableRunLastSeq: Int = 0

    /** Current active session; nullable — only created on first message. */
    private var sessionHandle: SessionStore.SessionHandle? = null

    /** Tool dispatchers for handling tool_call SSE events during both run and resume. */
    private var dispatcher: ToolDispatcher? = null
    private var gatherDispatcher: io.codepilot.plugin.tools.GatherDispatcher? = null
    private var graphStateStore: io.codepilot.plugin.tools.GraphStateStore? = null
    private var modelCatalog: List<Map<String, Any?>> = emptyList()
    private val usageRecords = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
    /** Local background task id → cloud registry id */
    private val bgCloudIds = java.util.concurrent.ConcurrentHashMap<String, String>()

    /**
     * Stores full code for context references. Key = contextId, Value = full code text.
     * This avoids embedding full code in messages, keeping messages compact and
     * allowing the code to be re-read from disk if needed.
     */
    private val contextStore = mutableMapOf<String, String>()

    /** Queued user messages for the active session (processed FIFO after the current turn ends). */
    private val pendingUserMessages = ArrayDeque<PendingUserMessage>()

    /** Snapshot of the message currently starting SSE (for server backoff retry). */
    private var inFlightSnapshot: PendingUserMessage? = null

    private var serverBackoffAttempts = 0
    private val conversationLock = Any()

    /** True while an SSE graph run is in flight for this chat panel. */
    @Volatile
    private var conversationInFlight = false

    /** After New Chat until the first message creates a session — blocks stale message hydration on reload. */
    @Volatile
    private var pendingFreshChat = false

    private data class PendingUserMessage(
        val text: String,
        val mode: String,
        val modelId: String?,
        val modelSource: String?,
        val contextRefs: List<Map<String, Any?>>,
        val images: List<Map<String, String>>,
        val historyMessages: List<Map<String, String>>,
        val freshChat: Boolean,
        val maxMode: Boolean,
        val effectiveModelId: String?,
        val effectiveModelSource: String?,
        val routedModel: Map<String, Any?>,
        /** v2 turn id — bootstrap may run before the message is dequeued. */
        val turnId: String,
    )

    /** Queued plugin→Web events until JCEF injects __codepilot_dispatch (quick actions on first open). */
    @Volatile
    private var webBridgeReady = false

    private val pendingWebDispatch = mutableListOf<Pair<String, Any?>>()

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
            sessionHandle?.let { sessionStore.appendEnvelope(it, env) }
        }
        io.codepilot.plugin.background.BackgroundTaskManager.getInstance(project).setDispatcher { type, payload ->
            dispatchToWeb(type, payload)
            if (type == "bg.tasks.update" && payload is Map<*, *>) {
                @Suppress("UNCHECKED_CAST")
                val tasks = payload["tasks"] as? List<Map<String, Any?>> ?: emptyList()
                tasks.forEach { task ->
                    val id = task["id"]?.toString() ?: return@forEach
                    if (id.startsWith("cloud-")) return@forEach
                    val status = task["status"]?.toString() ?: return@forEach
                    syncCloudTaskStatus(id, status, task["title"]?.toString())
                }
            }
        }
        io.codepilot.plugin.mcp.McpConfirmGate.getInstance(project).webDispatcher = { type, payload ->
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
                        markWebBridgeReady()
                        // Push session list and current session messages to the WebUI
                        dispatchSessionList()
                        dispatchCurrentSessionInfo()
                        if (pendingFreshChat || sessionHandle == null) {
                            dispatchToWeb(
                                "session_messages",
                                mapOf(
                                    "sessionId" to "",
                                    "messages" to emptyList<Map<String, Any?>>(),
                                    "abnormalTermination" to false,
                                    "hasCheckpoint" to false,
                                    "freshChat" to true,
                                ),
                            )
                        } else {
                            dispatchCurrentSessionMessages()
                        }
                        handleCheckAuth()
                        dispatchAppLocale()
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
        if (!webBridgeReady) {
            synchronized(pendingWebDispatch) {
                pendingWebDispatch.add(eventType to payload)
            }
            return
        }
        dispatchToWebNow(eventType, payload)
    }

    private fun dispatchToWebNow(
        eventType: String,
        payload: Any?,
    ) {
        val json = mapper.writeValueAsString(payload)
        val script = "window.__codepilot_dispatch && window.__codepilot_dispatch('$eventType', $json);"
        ApplicationManager.getApplication().invokeLater {
            browser.cefBrowser.executeJavaScript(script, "", 0)
        }
    }

    private fun markWebBridgeReady() {
        webBridgeReady = true
        val pending =
            synchronized(pendingWebDispatch) {
                pendingWebDispatch.toList().also { pendingWebDispatch.clear() }
            }
        pending.forEach { (type, payload) -> dispatchToWebNow(type, payload) }
    }

    override fun focusChatTab() {
        dispatchToWeb("ui.focus_chat", emptyMap<String, Any>())
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
        val dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { tcId, ok, result, errorCode, errorMessage ->
            dispatchToWeb(
                "tool_result_ack",
                mapOf(
                    "toolCallId" to tcId,
                    "ok" to ok,
                    "result" to result,
                    "error" to errorMessage,
                    "errorCode" to errorCode,
                ),
            )
        })
        dispatcher.dispatch(payload)
    }

    /**
     * Shortcut from IDE actions (Refactor / Review / …): sends the same payload as a WebUI `user_message`,
     * including optional inline `\u0001{ctxId}\u0001` markers that [handleUserMessage] expands from [contextStore].
     */
    override fun submitQuickUserMessage(
        textWithInlineContextMarkers: String,
        contextRefs: List<Map<String, Any?>>,
        mode: String,
    ) {
        handleUserMessage(
            text = textWithInlineContextMarkers,
            mode = mode,
            modelId = null,
            modelSource = null,
            contextRefs = contextRefs,
            images = emptyList(),
            historyMessages = emptyList(),
            freshChat = false,
            maxMode = false,
        )
    }

    /** Store context fullCode by ID — avoids embedding code in messages. */
    override fun storeContext(
        id: String,
        fullCode: String,
    ) {
        contextStore[id] = fullCode
    }

    override fun dispatchContextAdded(meta: Map<String, Any?>) {
        dispatchToWeb("context_added", meta)
    }

    override fun prepareFreshChatSession() {
        beginNewChatSession()
    }

    override fun dispose() {
        project.service<CefChatPanelRegistry>().unregister(this)
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
                    onToolResult = { _, ok, result, errorCode, errorMessage ->
                        val classified = io.codepilot.plugin.protocol.ToolResultClassifier
                            .classify(tool, args, ok, result, errorCode, errorMessage)
                        bus.toolResult(turnId, rerunStepId, ok, classified, errorMessage)
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
        patchStaging.acceptAllForTurn(turnId)
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

    // ---- P1 Marketplace skills ---- //
    private fun handleSkillList(payload: com.fasterxml.jackson.databind.JsonNode) {
        dispatchSkillListAfter(payload) {
            val page = io.codepilot.plugin.marketplace.SkillMarketplaceBridge.listSkillsPage(project, payload)
            mapOf(
                "skills" to page.skills,
                "page" to page.page,
                "pageSize" to page.pageSize,
                "total" to page.total,
                "hasMore" to page.hasMore,
            )
        }
    }

    private fun handleSkillInstall(payload: com.fasterxml.jackson.databind.JsonNode) {
        dispatchSkillListAfter(payload) {
            val err = io.codepilot.plugin.marketplace.SkillMarketplaceBridge.install(project, payload)
            if (err != null) {
                com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        dispatchToWeb("marketplace.error", mapOf("message" to err))
                    }
                }
            }
            skillListPayload(payload)
        }
    }

    private fun handleSkillUninstall(payload: com.fasterxml.jackson.databind.JsonNode) {
        dispatchSkillListAfter(payload) {
            io.codepilot.plugin.marketplace.SkillMarketplaceBridge.uninstall(project, payload)
            skillListPayload(payload)
        }
    }

    private fun handleSkillToggle(payload: com.fasterxml.jackson.databind.JsonNode) {
        dispatchSkillListAfter(payload) {
            io.codepilot.plugin.marketplace.SkillMarketplaceBridge.toggle(project, payload)
            skillListPayload(payload)
        }
    }

    private fun skillListPayload(
        payload: com.fasterxml.jackson.databind.JsonNode,
    ): Map<String, Any?> {
        val page = io.codepilot.plugin.marketplace.SkillMarketplaceBridge.listSkillsPage(project, payload)
        return mapOf(
            "skills" to page.skills,
            "page" to page.page,
            "pageSize" to page.pageSize,
            "total" to page.total,
            "hasMore" to page.hasMore,
        )
    }

    private fun dispatchSkillListAfter(
        payload: com.fasterxml.jackson.databind.JsonNode,
        block: () -> Map<String, Any?>,
    ) {
        io.codepilot.plugin.marketplace.SkillMarketplaceBridge.runAsync(project, {
            val result = block()
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) {
                    dispatchToWeb("skill_list_result", result)
                }
            }
        }) {}
    }

    private fun handleSkillCreateLocal(payload: JsonNode) {
        val id = payload.path("id").asText("").trim()
        val version = payload.path("version").asText("").trim()
        val title = payload.path("title").asText("").trim()
        val prompt = payload.path("prompt").asText("")
        val scopeStr = payload.path("scope").asText("project").lowercase()
        val scope =
            if (scopeStr == "global") {
                io.codepilot.plugin.marketplace.LocalMarketplaceStore.Scope.GLOBAL
            } else {
                io.codepilot.plugin.marketplace.LocalMarketplaceStore.Scope.PROJECT
            }
        val language = payload.path("language").asText("").trim().ifEmpty { null }
        val action = payload.path("action").asText("").trim().ifEmpty { null }
        ApplicationManager.getApplication().executeOnPooledThread {
            val result =
                io.codepilot.plugin.marketplace.LocalSkillCreator.create(
                    project,
                    id,
                    version,
                    title,
                    scope,
                    language,
                    action,
                    prompt,
                )
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) {
                    return@invokeLater
                }
                dispatchToWeb(
                    "skill_create_result",
                    mapOf(
                        "ok" to result.isSuccess,
                        "message" to (result.exceptionOrNull()?.message ?: ""),
                        "id" to id,
                        "version" to version,
                    ),
                )
            }
        }
    }

    private fun handleSkillOpenWizard() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) {
                return@invokeLater
            }
            io.codepilot.plugin.marketplace.NewSkillWizard(
                project,
                io.codepilot.plugin.marketplace.LocalMarketplaceStore.getInstance(),
            ) { }.show()
        }
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

    private fun handleMcpConfirmResponse(payload: com.fasterxml.jackson.databind.JsonNode) {
        io.codepilot.plugin.mcp.McpConfirmGate.getInstance(project).complete(
            confirmId = payload.path("confirmId").asText(""),
            approved = payload.path("approved").asBoolean(false),
            trustTool = payload.path("trustTool").asBoolean(false),
            trustServer = payload.path("trustServer").asBoolean(false),
            serverId = payload.path("serverId").asText(null),
            toolName = payload.path("toolName").asText(null),
        )
    }

    private fun handleMcpInstallJson(payload: JsonNode) {
        val raw = payload.path("json").asText("")
        val defaultName = payload.path("defaultName").asText("mcp-server").trim().ifEmpty { "mcp-server" }
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = io.codepilot.plugin.mcp.McpJsonInstaller.parseAndPersist(raw, defaultName)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) {
                    return@invokeLater
                }
                result.fold(
                    onSuccess = { (count, ids) ->
                        dispatchToWeb(
                            "mcp.install_result",
                            mapOf(
                                "ok" to true,
                                "message" to "Installed $count server(s): ${ids.joinToString()}",
                                "ids" to ids,
                                "count" to count,
                            ),
                        )
                        dispatchToWeb(
                            "mcp.response",
                            mapOf("servers" to mcpService.reloadConfig()),
                        )
                    },
                    onFailure = { e ->
                        dispatchToWeb(
                            "mcp.install_result",
                            mapOf(
                                "ok" to false,
                                "message" to (e.message ?: "install failed"),
                            ),
                        )
                    },
                )
            }
        }
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
                        freshChat = payload["freshChat"]?.asBoolean(false) ?: false,
                        maxMode = payload["maxMode"]?.asBoolean(false) ?: false,
                    )
                "fetch_models" -> handleFetchModels()
                "stop" -> handleStop()
                "shell.grant" -> handleShellGrant(payload)
                "risk_approved" -> handleRiskApproval(payload["approved"]?.asBoolean() ?: false)
                "needs_input_response" -> handleNeedsInputResponse(payload)
                "admission_retry_resume" -> handleAdmissionRetryResume()
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
                "context.estimate" -> handleContextEstimate(payload)
                "context.add_ref" -> handleContextAddRef(payload)
                "bg.submit" -> handleBgSubmit(payload)
                "bg.list" -> handleBgList()
                "bg.cancel" -> handleBgCancel(payload)
                "bg.merge" -> handleBgMerge(payload)
                "bg.discard" -> handleBgDiscard(payload)
                "bg.open_worktree" -> handleBgOpenWorktree(payload)
                "bg.respond" -> handleBgRespond(payload)
                "usage.set_quota" -> handleUsageSetQuota(payload)
                "export.preview" -> handleExportPreview(payload)
                "export.save_file" -> handleExportSave(payload)
                "share.create" -> handleShareCreate(payload)
                "share.get" -> handleShareGet(payload)
                "share.status.get" -> handleShareStatus()
                // Auth messages from login page
                "check_auth" -> handleCheckAuth()
                "set_preferred_locale" -> handleSetPreferredLocale(payload)
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
                "mcp.confirm.response" -> handleMcpConfirmResponse(payload)
                "mcp.install_json" -> handleMcpInstallJson(payload)
                "hooks.list" -> handleHooksList()
                "hooks.save" -> handleHooksSave(payload)
                // P1-08 shell policy
                "shell.policy_get" -> handleShellPolicyGet()
                "shell.policy_save" -> handleShellPolicySave(payload)
                // P1 Marketplace skills
                "skill_list" -> handleSkillList(payload)
                "skill_install" -> handleSkillInstall(payload)
                "skill_uninstall" -> handleSkillUninstall(payload)
                "skill_toggle" -> handleSkillToggle(payload)
                "skill.create_local" -> handleSkillCreateLocal(payload)
                "skill.open_wizard" -> handleSkillOpenWizard()
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
        freshChat: Boolean = false,
        maxMode: Boolean = false,
        /** When draining the queue, the user message was already persisted. */
        skipUserPersist: Boolean = false,
        /** When draining the queue, reuse the turn bootstrapped at enqueue time. */
        reuseTurnId: String? = null,
    ) {
        // Never run the heavy body on EDT — SSE calls can block for minutes.
        if (com.intellij.openapi.application.ApplicationManager.getApplication().isDispatchThread) {
            com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
                handleUserMessage(
                    text, mode, modelId, modelSource, contextRefs, images,
                    historyMessages, freshChat, maxMode, skipUserPersist, reuseTurnId,
                )
            }
            return
        }
        if (images.isNotEmpty() && !maxMode && !modelId.isNullOrBlank() && modelId != "auto") {
            val caps =
                modelCatalog.find { it["id"] == modelId }?.get("capabilities") as? Collection<*>
                    ?: emptyList<Any>()
            if (!caps.contains("VISION")) {
                dispatchToWeb(
                    "error",
                    mapOf(
                        "code" to 40001,
                        "message" to "Selected model does not support images. Use Auto, Max, or a vision-capable model.",
                    ),
                )
                return
            }
        }
        // Ensure a session exists (lazy creation on first message)
        val routedModel = routeModel(modelId, text, mode, images.isNotEmpty(), maxMode)
        val effectiveModelId = routedModel["id"] as? String ?: modelId
        val effectiveModelSource = routedModel["source"] as? String ?: modelSource
        val createdNewSession = sessionHandle == null
        if (createdNewSession) {
            sessionHandle = sessionStore.newSession(workspaceHash, mode, effectiveModelId, effectiveModelSource)
            pendingFreshChat = false
        }
        val handle = sessionHandle!!

        // Display text is just the user's text — context refs are shown as chips via contextRefs field
        val displayText = text

        // Persist the compact display message locally (including contextRefs for session restore)
        val userMsgExtra = mutableMapOf<String, Any?>()
        if (contextRefs.isNotEmpty()) userMsgExtra["contextRefs"] = contextRefs
        val imageDtos =
            images.mapNotNull { img ->
                val b64 = img["base64"]?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val mime = img["mimeType"] ?: "image/png"
                mapOf(
                    "url" to "data:$mime;base64,$b64",
                    "mimeType" to mime,
                    "name" to (img["name"] ?: ""),
                )
            }
        if (imageDtos.isNotEmpty()) userMsgExtra["images"] = imageDtos
        if (!skipUserPersist) {
            sessionStore.appendMessage(handle, "user", displayText, userMsgExtra.toMap())
            // Auto-derive title from first user message
            if (handle.meta.title.isNullOrBlank()) {
                sessionStore.updateMeta(handle) { meta ->
                    meta.title = text.take(50)
                }
            }
            sessionStore.touchLastMessage(handle)
            dispatchToWeb(
                "user_message_saved",
                mapOf(
                    "role" to "user",
                    "content" to displayText,
                    "contextRefs" to contextRefs,
                    "images" to imageDtos,
                ),
            )
            if (createdNewSession) {
                dispatchToWeb(
                    "session_switched",
                    mapOf("id" to handle.meta.id, "promote" to true),
                )
                dispatchSessionList()
            }
        }
        val forkMessageIndex = sessionStore.readMessages(handle).size - 1

        // Bootstrap v2 turn (turn.start envelope) before queue/admission so the WebUI always
        // shows the user message — including when the run is queued or waiting on admission.
        val turnId =
            reuseTurnId?.takeIf { it.isNotBlank() }
                ?: "turn-${System.currentTimeMillis()}-${kotlin.math.abs(text.hashCode())}"
        if (legacyAdapter == null || legacyAdapter!!.turnId != turnId) {
            legacyAdapter = io.codepilot.plugin.protocol.LegacyEventAdapter(eventBus, turnId)
            legacyAdapter!!.onTurnStart(displayText, contextRefs, imageDtos, forkMessageIndex)
        }

        val messageSnapshot =
            PendingUserMessage(
                text,
                mode,
                modelId,
                modelSource,
                contextRefs,
                images,
                historyMessages,
                freshChat,
                maxMode,
                effectiveModelId,
                effectiveModelSource,
                routedModel,
                turnId,
            )

        val queued =
            synchronized(conversationLock) {
                if (conversationInFlight) {
                    pendingUserMessages.add(messageSnapshot)
                    true
                } else {
                    conversationInFlight = true
                    inFlightSnapshot = messageSnapshot
                    false
                }
            }
        if (queued) {
            dispatchMessageQueueSnapshot()
            dispatchToWeb(
                "message_queued",
                mapOf("queueSize" to pendingUserMessages.size),
            )
            return
        }
        if (mode.equals("agent", ignoreCase = true)) {
            // Non-blocking admission probe: single-shot, no Thread.sleep.
            // If not admitted, emit queue status to UI and schedule a delayed retry.
            val status = io.codepilot.plugin.conversation.ConversationRunAdmission.probe()
            if (status == null || !status.admit) {
                // Probe failed or queue full — show queue status in UI immediately
                dispatchToWeb(
                    "admission_queued",
                    mapOf(
                        "retryAfterSec" to (status?.retryAfterSec ?: 30),
                        "attempt" to 1,
                        "maxAttempts" to 3,
                        "message" to if (status != null)
                            "服务端 Agent 队列繁忙（排队 ${status.userQueued}，运行中 ${status.userRunning}/${status.maxUserRunning}），正在等待空位…"
                        else
                            "无法连接到服务端，正在重试…",
                        "userQueued" to (status?.userQueued ?: 0),
                        "userRunning" to (status?.userRunning ?: 0),
                        "globalQueued" to (status?.globalQueued ?: 0),
                        "globalRunning" to (status?.globalRunning ?: 0),
                    ),
                )
                scheduleAdmissionRetry(attempt = 1, maxAttempts = 3, intervalSec = (status?.retryAfterSec ?: 30))
                return
            }
        }

        // v2 protocol: continue the turn envelope flow (adapter already started above).

        // Build the full message for backend (replace inline placeholders with actual code)
        val fullText = InlineContextExpander.expand(text, contextStore, contextRefs)
        dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { toolCallId, ok, result, errorCode, errorMessage ->
            dispatchToWeb(
                "tool_result_ack",
                mapOf(
                    "toolCallId" to toolCallId,
                    "ok" to ok,
                    "result" to result,
                    "error" to errorMessage,
                    "errorCode" to errorCode,
                ),
            )
            legacyAdapter?.onToolResultAck(toolCallId, ok, result, errorMessage, errorCode)
            sessionStore.appendStep(handle, mapOf(
                "toolCallId" to toolCallId,
                "ok" to ok,
                "result" to result,
                "turnId" to turnId,
                "ts" to java.time.Instant.now().toString(),
            ))
        }).apply { currentTurnId = turnId }
        gatherDispatcher =
            io.codepilot.plugin.tools
                .GatherDispatcher(project, client, handle.meta.id) { toolCallId, ok, httpResponse ->
                    // Dispatch tool_result_ack to WebUI when gather execution completes
                    dispatchToWeb(
                        "tool_result_ack",
                        mapOf("toolCallId" to toolCallId, "ok" to ok, "result" to httpResponse),
                    )
                    legacyAdapter?.onToolResultAck(toolCallId, ok, httpResponse)
                    // Record the tool result step
                    sessionStore.appendStep(handle, mapOf(
                        "toolCallId" to toolCallId,
                        "ok" to ok,
                        "result" to httpResponse,
                        "turnId" to turnId,
                        "ts" to java.time.Instant.now().toString(),
                    ))
                }
        graphStateStore =
            io.codepilot.plugin.tools
                .GraphStateStore(project, handle.dir)
        graphStateStore!!.loadLatest()

        ApplicationManager.getApplication().executeOnPooledThread {
            // Capture nullable class members as local non-null vals for safe usage in listener
            val gss = graphStateStore!!
            val disp = dispatcher!!
            val gd = gatherDispatcher!!

            val messageCount = sessionStore.readMessages(handle).size
            val webUiHistoryPreview =
                historyMessages.takeLast(10).map { msg ->
                    mapOf("role" to msg["role"], "content" to msg["content"]?.take(2000))
                }

            // Resume from graph askUser interrupt: use /resume with checkpoint token
            var useGraphResume = false
            if (mode == "agent") {
                val continuationToken =
                    gss.snapshot().path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }
                if (gss.isAwaiting() && continuationToken != null) {
                    useGraphResume = true
                }
            }
            val effectiveFreshChat = freshChat && !useGraphResume

            val runIntent =
                when {
                    useGraphResume -> "answer"
                    mode == "agent" &&
                        !effectiveFreshChat &&
                        (webUiHistoryPreview.isNotEmpty() || messageCount > 1) &&
                        gss.hasPersistedSessionContext() -> "continue"
                    else -> "new"
                }

            val payload =
                mutableMapOf<String, Any?>(
                    "sessionId" to handle.meta.id,
                    "mode" to mode,
                    "input" to fullText,
                    "intent" to runIntent,
                )
            if (runIntent == "continue") {
                @Suppress("UNCHECKED_CAST")
                payload["graphState"] = mapper.convertValue(gss.snapshot(), Map::class.java) as Map<String, Any?>
            }
            if (effectiveModelId != null && effectiveModelId != "auto") payload["modelId"] = effectiveModelId
            if (effectiveModelSource != null) payload["modelSource"] = effectiveModelSource

            // ★ Inject project meta (language, root files) so LLM knows project context
            payload["projectMeta"] = buildProjectMeta()

            // ★ Skills (plugin): userSkillRefs = trigger metadata; userSkillBodies = full prompt
            //   text only for IDE coarse-matched skills. Backend GraphNodeSkillMatcher re-runs
            //   trigger checks per graph node — a skill "hits" only when the node matches AND
            //   a non-empty body was supplied (no server-side execution of skills).
            val rootHash = io.codepilot.plugin.marketplace.SkillRefCollector.projectRootHash(project)
            val skillPayload =
                io.codepilot.plugin.marketplace.SkillRefCollector.collect(project, rootHash)
            if (skillPayload.refs.isNotEmpty()) {
                payload["userSkillRefs"] = skillPayload.refs
                payload["projectRootHash"] = rootHash
            }
            if (skillPayload.bodies.isNotEmpty()) {
                payload["userSkillBodies"] = skillPayload.bodies
            }

            // ★ MCP: mcpTools = JSON Schema for the model only. Actual mcp.* tool_call invocations
            //   are executed locally in the IDE (ToolDispatcher → McpProcessManager), not on the server.
            try {
                val mcpTools = dispatcher?.initMcpServers() ?: emptyList()
                if (mcpTools.isNotEmpty()) {
                    payload["mcpTools"] = mcpTools
                }
            } catch (e: Exception) {
                com.intellij.openapi.diagnostic.Logger.getInstance("CefChatPanel")
                    .warn("Failed to fetch MCP tool metadata: ${e.message}")
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

            if (useGraphResume) {
                val continuationToken =
                    gss.snapshot().path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }
                if (continuationToken != null) {
                    payload["continuationToken"] = continuationToken
                    payload["graphState"] = gss.snapshot()
                    if (fullText.isNotBlank()) {
                        payload["input"] = fullText
                        payload["answers"] = listOf(mapOf("freeform" to fullText))
                    }
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
            val localRecent = lastMessages.takeLast(6).map { msg ->
                mapOf("role" to msg["role"], "content" to (msg["content"] as? String)?.take(2000))
            }
            // Use WebUI history if available, otherwise fall back to local session messages
            val recentMessages =
                when {
                    effectiveFreshChat -> emptyList()
                    webUiHistoryPreview.isNotEmpty() -> webUiHistoryPreview
                    messageCount <= 1 -> emptyList()
                    else -> localRecent
                }

            payload["contexts"] =
                mapOf(
                    "pinned" to emptyList<Any>(),
                    "recent" to recentMessages,
                    "refs" to contextRefs,
                )
            // Estimate and report context usage
            val estimatedTokens = sessionStore.estimateTokenCount(handle)
            val budgetTotal = contextBudgetLimit()
            dispatchToWeb(
                "context_budget",
                mapOf(
                    "current" to estimatedTokens,
                    "total" to budgetTotal,
                    "estimated" to 0,
                    "breakdown" to budgetBreakdown(rulesText, memoryText, contextRefs, recentMessages, estimatedTokens),
                ),
            )
            payload["policy"] =
                mapOf(
                    "requestCompact" to "auto",
                    "selfCheck" to true,
                    "askPolicy" to "prefer-ask",
                    "contextBudgetTokens" to budgetTotal,
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
                finishConversationAndDrainQueue()
                return@executeOnPooledThread
            }

            // Collect full assistant response for local persistence
            val assistantBuilder = StringBuilder()
            val turnPlanSteps = mutableListOf<MutableMap<String, Any?>>()
            // ★ Guard to prevent duplicate assistant message persistence on double done events
            var assistantPersisted = false
            var terminalDoneReceived = false

            // Capture adapter for use inside the anonymous listener
            val adapter = legacyAdapter
            val capturedTurnId = legacyAdapter?.turnId
            val streamGen = activeStreamGeneration
            val streamSessionId = handle.meta.id
            fun isStaleStream(): Boolean =
                streamGen != activeStreamGeneration || sessionHandle?.meta?.id != streamSessionId

            dispatchToWeb("conversation_running", mapOf("running" to true))

            val startStream =
                if (useGraphResume) {
                    { listener: ConversationClient.Listener ->
                        client.resume(payload.toMap(), listener)
                    }
                } else {
                    { listener: ConversationClient.Listener ->
                        client.run(payload.toMap(), listener)
                    }
                }
            startStream(
                object : ConversationClient.Listener {
                    override fun onDelta(text: String) {
                        if (isStaleStream()) return
                        assistantBuilder.append(text)
                        dispatchToWeb("delta", mapOf("text" to text))
                        adapter?.onTextDelta(text)
                    }

                    override fun onToolCall(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("tool_call", data)
                        val toolName = payload.path("name").asText(null)
                        val toolCallId = payload.path("id").asText(null)
                        if (toolName != null && toolCallId != null) {
                            adapter?.onToolCall(toolCallId, toolName, payload.path("args"))
                            @Suppress("UNCHECKED_CAST")
                            val argsMap =
                                if (payload.path("args").isObject) {
                                    mapper.convertValue(payload.path("args"), Map::class.java)
                                        as Map<String, Any?>
                                } else {
                                    emptyMap()
                                }
                            // Persist tool call step for session recovery (started, no result yet)
                            sessionStore.appendStep(handle, mapOf(
                                "toolCallId" to toolCallId,
                                "toolName" to toolName,
                                "stepId" to "",
                                "started" to true,
                                "args" to argsMap,
                                "turnId" to (legacyAdapter?.turnId ?: turnId),
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
                        val data = mapper.treeToValue(payload, Map::class.java)
                        adapter?.onGraphTransition(data)
                    }

                    override fun onSkillsActivated(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("skills_activated", mapper.treeToValue(payload, Map::class.java))
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
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("graph_verify", data)
                        adapter?.onGraphVerify(data)
                    }

                    override fun onGraphRepairPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("graph_repair_plan", data)
                        adapter?.onGraphRepairPlan(data)
                    }

                    override fun onGraphPhaseDone(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        gss.applyPhaseDone(payload)
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("graph_phase_done", data)
                        adapter?.onGraphPhaseDone(data)
                    }

                    override fun onGraphCheckpoint(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        gss.applyCheckpoint(payload)
                    }

                    override fun onGraphBudgetAlert(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("graph_budget_alert", data)
                        adapter?.onGraphBudgetAlert(data)
                    }

                    // ── Memory system events ──
                    override fun onMemoryCompacted(payload: com.fasterxml.jackson.databind.JsonNode) {
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("memory.compacted", data)
                        // Persist compacted marker into local session digest for recovery
                        val compacted = data["__COMPACTED__"] as? Boolean == true
                        if (compacted) {
                            val summary = data["summary"] as? String
                            if (summary != null) {
                                sessionStore.saveDigest(handle, mapOf(
                                    "compactedSummary" to summary,
                                    "__COMPACTED__" to true,
                                    "phaseId" to (data["phaseId"] ?: ""),
                                    "compressedCount" to (data["compressedCount"] ?: 0),
                                ))
                            }
                        }
                    }

                    // ── User-facing plan events (shown in Plan panel) ──
                    override fun onUserPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        val data = mapper.treeToValue(payload, Map::class.java)
                        @Suppress("UNCHECKED_CAST")
                        val steps = data["steps"] as? List<Map<String, Any?>>
                        if (!steps.isNullOrEmpty()) {
                            turnPlanSteps.clear()
                            for (s in steps) {
                                turnPlanSteps.add(
                                    mutableMapOf(
                                        "id" to (s["id"]?.toString() ?: ""),
                                        "title" to (s["title"]?.toString() ?: ""),
                                        "status" to (s["status"]?.toString() ?: "pending"),
                                    ),
                                )
                            }
                        }
                        dispatchToWeb("user_plan", data)
                        adapter?.onPlanUpdate(data)
                    }

                    override fun onUserPlanProgress(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        val data = mapper.treeToValue(payload, Map::class.java)
                        val stepId = data["stepId"]?.toString()
                        val stepIndex = (data["stepIndex"] as? Number)?.toInt()
                        val status = data["status"]?.toString()
                        val completedSteps = (data["completedSteps"] as? Number)?.toInt()
                        if (turnPlanSteps.isNotEmpty()) {
                            if (!stepId.isNullOrBlank()) {
                                turnPlanSteps
                                    .filter { it["id"]?.toString() == stepId }
                                    .forEach { if (status != null) it["status"] = status }
                            } else if (stepIndex != null && stepIndex in turnPlanSteps.indices && status != null) {
                                turnPlanSteps[stepIndex]["status"] = status
                            }
                            if (completedSteps != null && completedSteps > 0) {
                                for (i in 0 until completedSteps.coerceAtMost(turnPlanSteps.size)) {
                                    val cur = turnPlanSteps[i]["status"]?.toString() ?: "pending"
                                    if (cur == "pending" || cur == "in_progress" || cur == "running") {
                                        turnPlanSteps[i]["status"] = "success"
                                    }
                                }
                            }
                        }
                        dispatchToWeb("user_plan_progress", data)
                        adapter?.onPlanProgress(data)
                    }

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
                        val filesNode = payload.path("files")
                        val files =
                            if (filesNode.isArray) {
                                filesNode.mapNotNull { node ->
                                    val path = node.path("path").asText(null) ?: return@mapNotNull null
                                    buildMap<String, Any?> {
                                        put("path", path)
                                        node.path("op").asText(null)?.let { put("op", it) }
                                        if (node.has("lineCount")) put("lineCount", node.path("lineCount").asInt())
                                        node.path("preview").asText(null)?.let { put("preview", it) }
                                    }
                                }
                            } else {
                                emptyList()
                            }
                        adapter?.onAgentWriting(payload.path("text").asText(null), files)
                    }

                    override fun onAgentRunning(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("agent_running", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentRunning(payload.path("text").asText(null))
                    }

                    override fun onRateLimited(
                        code: Int,
                        message: String,
                        retryAfterSec: Int,
                        opType: String?,
                    ) {
                        if (isStaleStream()) return
                        handleStreamRateLimited(streamGen, code, message, retryAfterSec, opType)
                    }

                    override fun onError(
                        code: Int,
                        message: String,
                    ) {
                        if (isStaleStream()) return
                        dispatchToWeb("error", mapOf("code" to code, "message" to message))
                        adapter?.onError(code, message)
                        if (!terminalDoneReceived) {
                            terminalDoneReceived = true
                            adapter?.onDone("failed")
                            finishConversationAndDrainQueue()
                        }
                    }

                    override fun onRunStarted(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        durableRunId = payload.path("runId").asText(null)
                        durableRunLastSeq = payload.path("afterSeq").asInt(0)
                        dispatchToWeb("run_started", mapper.treeToValue(payload, Map::class.java) as Map<String, Any?>)
                    }

                    override fun onRunReclaimed(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleStream()) return
                        dispatchToWeb("run_reclaimed", mapper.treeToValue(payload, Map::class.java) as Map<String, Any?>)
                    }

                    override fun onDone(
                        reason: String,
                        payload: com.fasterxml.jackson.databind.JsonNode,
                    ) {
                        if (isStaleStream()) return
                        dispatchToWeb("done", mapOf("reason" to reason))
                        adapter?.onDone(reason)
                        // Persist graph awaiting state for resume, or clear after user answered
                        if (reason == "awaiting_user_input" || reason == "phase_done") {
                            gss.applyAwaiting(payload)
                        } else if (reason != "deploy_draining") {
                            gss.clearAwaiting()
                        }
                        // ★ Only persist the assistant message on the FIRST done event
                        // with a "final" reason. Subsequent done events (e.g., from a
                        // duplicate ConversationService append) should be ignored to
                        // prevent duplicate message persistence.
                        // Intermediate done events (subtask_done, phase_done) should NOT
                        // trigger persistence — the graph execution is still in progress.
                        val isDeployDrain = reason == "deploy_draining"
                        if (isDeployDrain && !durableRunId.isNullOrBlank()) {
                            handleAttachDurableRun(durableRunId!!)
                            return
                        }
                        val isTerminalDone = TerminalDoneReasons.isTerminal(reason)
                        val isAwaitingUserInput = reason == "awaiting_user_input"
                        if (isTerminalDone) {
                            terminalDoneReceived = true
                            if (reason == "final") {
                                gss.applyRunComplete(payload)
                            }
                        }
                        if (isTerminalDone && !assistantPersisted) {
                            assistantPersisted = true
                            val fullResponse = assistantBuilder.toString()
                            // Rebuild tool calls from steps: merge "started" and "ok" records by toolCallId
                            val steps = sessionStore.readSteps(handle)
                            val turnToolCalls = sessionStore.mergeToolCallsFromSteps(steps, capturedTurnId)
                            if (fullResponse.isNotEmpty() || turnToolCalls.isNotEmpty() || turnPlanSteps.isNotEmpty()) {
                                val extra = mutableMapOf<String, Any?>()
                                if (turnToolCalls.isNotEmpty()) extra["toolCalls"] = turnToolCalls
                                if (turnPlanSteps.isNotEmpty()) {
                                    extra["planSteps"] = turnPlanSteps.map { it.toMap() }
                                }
                                if (!capturedTurnId.isNullOrBlank()) extra["turnId"] = capturedTurnId
                                sessionStore.appendMessage(handle, "assistant", fullResponse, extra.toMap())
                            }
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = false
                                meta.abnormalTermination = isDeployDrain
                            }
                            if (isDeployDrain) {
                                sessionStore.persistAbnormalCloseSnapshot(handle, gss.snapshot())
                                dispatchSessionInterrupted(handle, gss)
                            }
                            sessionStore.touchLastMessage(handle)
                            recordUsage(handle.meta.id, turnId, effectiveModelId ?: "default", routedModel["tier"] as? String ?: "DEFAULT", fullText, fullResponse)
                            dispatchSessionList() // refresh sidebar timestamps
                        }
                        if (isTerminalDone) {
                            finishConversationAndDrainQueue()
                        }
                        // awaiting_user_input is not a terminal done, but the stream will close
                        // after this. Mark the session as not-running so onClosed doesn't treat
                        // it as an abnormal termination.
                        if (isAwaitingUserInput) {
                            terminalDoneReceived = true  // prevent onClosed abnormal path
                            sessionHandle?.let { handle ->
                                sessionStore.updateMeta(handle) { meta ->
                                    meta.running = false
                                    meta.abnormalTermination = false
                                }
                            }
                        }
                    }

                    override fun onClosed() {
                        if (isStaleStream()) return
                        if (streamGen == rateLimitedStreamGen) {
                            rateLimitedStreamGen = -1
                            return
                        }
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
                                dispatchSessionInterrupted(handle, gss)
                            }
                        }
                        if (!terminalDoneReceived) {
                            finishConversationAndDrainQueue()
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
        activeStreamGeneration++
        legacyAdapter = null
        client.stop(sid)
        finishConversationAndDrainQueue()
    }

    /**
     * Build project metadata string for LLM context.
     * Includes: detected languages, framework hints, root-level file listing.
     * This prevents the LLM from guessing non-existent files like package.json or requirements.txt.
     */
    private fun buildProjectMeta(): String = buildProjectMetaSnippet(project)

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

            val resumeTurnId = "resume-${System.currentTimeMillis()}"
            val dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { toolCallId, ok, result, errorCode, errorMessage ->
            dispatchToWeb(
                "tool_result_ack",
                mapOf(
                    "toolCallId" to toolCallId,
                    "ok" to ok,
                    "result" to result,
                    "error" to errorMessage,
                    "errorCode" to errorCode,
                ),
            )
            sessionStore.appendStep(handle, mapOf(
                "toolCallId" to toolCallId,
                "ok" to ok,
                "result" to result,
                "turnId" to resumeTurnId,
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
                            @Suppress("UNCHECKED_CAST")
                            val argsMap =
                                if (payload.path("args").isObject) {
                                    mapper.convertValue(payload.path("args"), Map::class.java)
                                        as Map<String, Any?>
                                } else {
                                    emptyMap()
                                }
                            sessionStore.appendStep(handle, mapOf(
                                "toolCallId" to toolCallId,
                                "toolName" to toolName,
                                "stepId" to "",
                                "started" to true,
                                "args" to argsMap,
                                "turnId" to resumeTurnId,
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
                        val resultNode = payload.path("result")
                        val resultMap =
                            if (resultNode.isObject) {
                                @Suppress("UNCHECKED_CAST")
                                mapper.convertValue(resultNode, Map::class.java) as Map<String, Any?>
                            } else {
                                null
                            }
                        dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok, "result" to resultMap))
                        if (toolCallId != null) {
                            sessionStore.appendStep(handle, mapOf(
                                "toolCallId" to toolCallId,
                                "ok" to ok,
                                "result" to resultMap,
                                "turnId" to resumeTurnId,
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
                        } else if (reason != "deploy_draining") {
                            graphStateStore.clearAwaiting()
                        }
                        val fullResponse = assistantBuilder.toString()
                        val steps = sessionStore.readSteps(handle)
                        val turnToolCalls = sessionStore.mergeToolCallsFromSteps(steps, resumeTurnId)
                        if (fullResponse.isNotEmpty() || turnToolCalls.isNotEmpty()) {
                            val extra = mutableMapOf<String, Any?>()
                            if (turnToolCalls.isNotEmpty()) extra["toolCalls"] = turnToolCalls
                            extra["turnId"] = resumeTurnId
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
                                dispatchSessionInterrupted(h, graphStateStore)
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

    private fun handleShellGrant(payload: com.fasterxml.jackson.databind.JsonNode) {
        val token = payload.path("token").asText("").ifBlank { return }
        val decision =
            when (payload.path("decision").asText("deny")) {
                "allow", "run" -> io.codepilot.plugin.shell.ShellGrantDecision.ALLOW
                "skip" -> io.codepilot.plugin.shell.ShellGrantDecision.SKIP
                else -> io.codepilot.plugin.shell.ShellGrantDecision.DENY
            }
        io.codepilot.plugin.shell.ShellGrantWaiter.complete(token, decision)
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

        // Prefer token from WebUI payload, then GraphStateStore (persisted by applyAwaiting)
        val continuationToken =
            payload.path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }
                ?: currentGraphStateStore.snapshot().path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }

        log.info("NeedsInputResponse: sessionId=$sid, continuationToken=$continuationToken, answersCount=${answers.size}")

        if (continuationToken == null) {
            log.warn("NeedsInputResponse: missing continuationToken, cannot resume graph")
            dispatchToWeb(
                "error",
                mapOf("code" to 50002, "message" to "Missing continuation token; cannot resume agent run"),
            )
            return
        }

        // Build resume payload using SessionStore (includes graphState, completedToolCalls, etc.)
        // ★ FIX: Only use freeform text as input — never fall back to optionId.
        // When the user selects a structured option (e.g. optionId="manual"), using the
        // optionId as `input` causes the LLM to misinterpret it (e.g. "manual" → "user manual"
        // instead of "I'll handle it manually"). The optionId semantics are carried by the
        // structured `answers` list; the `input` field should only contain freeform text.
        val userInput = answers.mapNotNull { a -> a["freeform"]?.toString() }.filter { it.isNotBlank() }.joinToString("; ")
        val resumePayload = sessionStore.buildResumePayload(handle, userInput, handle.meta.modelId ?: "default")
        // Override with the actual answers and continuationToken from this response
        val fullPayload = resumePayload.toMutableMap()
        fullPayload["answers"] = answers
        fullPayload["intent"] = "answer"
        fullPayload["continuationToken"] = continuationToken
        if (answers.isEmpty() && userInput.isNotBlank()) {
            fullPayload["answers"] = listOf(mapOf("freeform" to userInput))
        }

        // Call /v1/conversation/resume which triggers GraphEngine.resume()
        // ★ Notify WebUI that resume is starting (clears interrupted banner)
        dispatchToWeb("session_resuming", mapOf("sessionId" to sid))
        synchronized(conversationLock) {
            conversationInFlight = true
        }
        activeStreamGeneration++
        val resumeStreamGen = activeStreamGeneration
        val resumeStreamSessionId = sid
        sessionStore.updateMeta(handle) { meta ->
            meta.running = true
            meta.abnormalTermination = false
        }
        dispatchToWeb("conversation_running", mapOf("running" to true))

        ApplicationManager.getApplication().executeOnPooledThread {
            val assistantBuilder = StringBuilder()
            var assistantPersisted = false
            var terminalDoneReceived = false
            var resumeRateLimited = false
            val adapter = legacyAdapter
            fun isStaleResumeStream(): Boolean =
                resumeStreamGen != activeStreamGeneration || sessionHandle?.meta?.id != resumeStreamSessionId

            client.resume(
                fullPayload.toMap(),
                object : ConversationClient.Listener {
                    override fun onDelta(text: String) {
                        if (isStaleResumeStream()) return
                        assistantBuilder.append(text)
                        dispatchToWeb("delta", mapOf("text" to text))
                        adapter?.onTextDelta(text)
                    }

                    override fun onToolCall(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        val data = mapper.treeToValue(payload, Map::class.java)
                        dispatchToWeb("tool_call", data)
                        val toolName = payload.path("name").asText(null)
                        val toolCallId = payload.path("id").asText(null)
                        if (toolName != null && toolCallId != null) {
                            adapter?.onToolCall(toolCallId, toolName, payload.path("args"))
                            currentDispatcher.dispatch(payload)
                        }
                    }

                    override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onNeedsInput(mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onGraphPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        currentGraphStateStore.applyGraphPlan(payload)
                    }

                    override fun onGraphTransition(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        currentGraphStateStore.applyTransition(payload)
                        adapter?.onGraphTransition(mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onGraphInfoRequest(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        val toolCallId = payload.path("toolCallId").asText("gather-batch")
                        currentGatherDispatcher?.dispatchBatch(payload.path("requests"), toolCallId)
                    }

                    override fun onGraphVerify(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        currentGraphStateStore.applyVerify(payload)
                        adapter?.onGraphVerify(mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onGraphPhaseDone(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        currentGraphStateStore.applyPhaseDone(payload)
                        adapter?.onGraphPhaseDone(mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onUserPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        adapter?.onPlanUpdate(mapper.treeToValue(payload, Map::class.java))
                        dispatchToWeb("user_plan", mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onUserPlanProgress(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        adapter?.onPlanProgress(mapper.treeToValue(payload, Map::class.java))
                        dispatchToWeb("user_plan_progress", mapper.treeToValue(payload, Map::class.java))
                    }

                    override fun onAgentThinking(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("agent_thinking", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentThinking(payload.path("text").asText(null))
                    }

                    override fun onAgentReading(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("agent_reading", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentReading(payload.path("summary").asText(null))
                    }

                    override fun onAgentWriting(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("agent_writing", mapper.treeToValue(payload, Map::class.java))
                        val filesNode = payload.path("files")
                        val files =
                            if (filesNode.isArray) {
                                filesNode.mapNotNull { node ->
                                    val path = node.path("path").asText(null) ?: return@mapNotNull null
                                    buildMap<String, Any?> {
                                        put("path", path)
                                        node.path("op").asText(null)?.let { put("op", it) }
                                        if (node.has("lineCount")) put("lineCount", node.path("lineCount").asInt())
                                        node.path("preview").asText(null)?.let { put("preview", it) }
                                    }
                                }
                            } else {
                                emptyList()
                            }
                        adapter?.onAgentWriting(payload.path("text").asText(null), files)
                    }

                    override fun onAgentRunning(payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("agent_running", mapper.treeToValue(payload, Map::class.java))
                        adapter?.onAgentRunning(payload.path("text").asText(null))
                    }

                    override fun onDone(reason: String, payload: com.fasterxml.jackson.databind.JsonNode) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("done", mapOf("reason" to reason))
                        adapter?.onDone(reason)
                        if (reason == "awaiting_user_input" || reason == "phase_done") {
                            currentGraphStateStore.applyAwaiting(payload)
                        } else if (reason != "deploy_draining") {
                            currentGraphStateStore.clearAwaiting()
                        }
                        val isTerminalDone = TerminalDoneReasons.isTerminal(reason)
                        val isAwaitingUserInput = reason == "awaiting_user_input"
                        if (isTerminalDone) {
                            terminalDoneReceived = true
                        }
                        if (isTerminalDone && !assistantPersisted) {
                            assistantPersisted = true
                            val fullResponse = assistantBuilder.toString()
                            if (fullResponse.isNotBlank()) {
                                sessionStore.appendMessage(handle, "assistant", fullResponse)
                            }
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = false
                                meta.abnormalTermination = false
                            }
                            sessionStore.touchLastMessage(handle)
                            dispatchSessionList()
                        }
                        if (isTerminalDone) {
                            finishConversationAndDrainQueue()
                        }
                        if (isAwaitingUserInput) {
                            terminalDoneReceived = true
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = false
                                meta.abnormalTermination = false
                            }
                        }
                    }

                    override fun onRateLimited(
                        code: Int,
                        message: String,
                        retryAfterSec: Int,
                        opType: String?,
                    ) {
                        if (isStaleResumeStream()) return
                        resumeRateLimited = true
                        handleStreamRateLimited(resumeStreamGen, code, message, retryAfterSec, opType)
                    }

                    override fun onError(code: Int, message: String) {
                        if (isStaleResumeStream()) return
                        dispatchToWeb("error", mapOf("code" to code, "message" to message))
                        adapter?.onError(code, message)
                        if (!resumeRateLimited && !terminalDoneReceived) {
                            terminalDoneReceived = true
                            adapter?.onDone("failed")
                            finishConversationAndDrainQueue()
                        }
                    }

                    override fun onClosed() {
                        if (isStaleResumeStream()) return
                        adapter?.onAbnormalClose()
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
                                dispatchSessionInterrupted(h, currentGraphStateStore)
                            }
                        }
                        if (!resumeRateLimited && !terminalDoneReceived) {
                            finishConversationAndDrainQueue()
                        }
                    }
                },
            )
        }
    }

    // ---- Session management ---- //

    fun handleNewSessionFromAction() {
        prepareFreshChatSession()
    }

    private fun handleNewSession() {
        beginNewChatSession()
    }

    private fun dispatchMessageQueueSnapshot() {
        val pending =
            synchronized(conversationLock) {
                pendingUserMessages.map { msg ->
                    mapOf(
                        "text" to msg.text.take(500),
                        "mode" to msg.mode,
                    )
                }
            }
        dispatchToWeb("message_queue_updated", mapOf("pending" to pending))
    }

    private fun handleStreamRateLimited(
        streamGen: Int,
        code: Int,
        message: String,
        retryAfterSec: Int,
        opType: String?,
    ) {
        if (streamGen != activeStreamGeneration) return
        rateLimitedStreamGen = streamGen
        sessionHandle?.let { h ->
            sessionStore.updateMeta(h) { meta ->
                meta.running = false
                meta.abnormalTermination = false
            }
        }
        val waitSec = retryAfterSec.coerceIn(5, 120)
        val queueFull = code == io.codepilot.plugin.conversation.SseHttpErrors.API_CODE_QUEUE_FULL
        dispatchToWeb(
            "rate_limited",
            mapOf(
                "code" to code,
                "message" to message,
                "retryAfterSec" to waitSec,
                "opType" to (opType ?: ""),
                "queueFull" to queueFull,
            ),
        )
        dispatchToWeb(
            "server_backoff",
            mapOf(
                "retryAfterSec" to waitSec,
                "message" to message,
                "attempt" to (serverBackoffAttempts + 1),
            ),
        )
        if (serverBackoffAttempts >= 8) {
            dispatchToWeb("error", mapOf("code" to code, "message" to message))
            legacyAdapter?.onDone("stopped")
            inFlightSnapshot = null
            finishConversationAndDrainQueue()
            return
        }
        serverBackoffAttempts++
        val snapshot = inFlightSnapshot
        synchronized(conversationLock) {
            conversationInFlight = false
            if (snapshot != null) {
                pendingUserMessages.addFirst(snapshot)
            }
            inFlightSnapshot = null
        }
        dispatchMessageQueueSnapshot()
        legacyAdapter?.onDone("stopped")
        ApplicationManager.getApplication().executeOnPooledThread {
            Thread.sleep(waitSec * 1000L + (500L..2500L).random())
            if (queueFull || opType == "agent-queue") {
                io.codepilot.plugin.conversation.ConversationRunAdmission.probe()
            }
            finishConversationAndDrainQueue()
        }
    }

    private fun handleAdmissionRetryResume() {
        val snapshot = synchronized(conversationLock) { inFlightSnapshot }
        if (snapshot == null) {
            finishConversationAndDrainQueue()
            return
        }
        // User confirmed retry — reset attempt counter and retry from attempt 1
        scheduleAdmissionRetry(attempt = 1, maxAttempts = 3, intervalSec = 30)
    }

    /**
     * Schedules an asynchronous admission retry after [intervalSec] seconds.
     * After [maxAttempts] failures, asks the user whether to keep retrying.
     * This is fully non-blocking — the IDE stays responsive while waiting.
     */
    private fun scheduleAdmissionRetry(attempt: Int, maxAttempts: Int, intervalSec: Int) {
        ApplicationManager.getApplication().executeOnPooledThread {
            Thread.sleep(intervalSec * 1000L)
            // Check if the panel was disposed or session switched while sleeping
            val snapshot = synchronized(conversationLock) { inFlightSnapshot } ?: return@executeOnPooledThread

            val status = io.codepilot.plugin.conversation.ConversationRunAdmission.probe()
            if (status == null || !status.admit) {
                // Still not admitted
                if (attempt < maxAttempts) {
                    // More retries left — update UI with current attempt
                    dispatchToWeb(
                        "admission_queued",
                        mapOf(
                            "retryAfterSec" to (status?.retryAfterSec ?: 30),
                            "attempt" to attempt + 1,
                            "maxAttempts" to maxAttempts,
                            "message" to if (status != null)
                                "服务端 Agent 队列繁忙（排队 ${status.userQueued}，运行中 ${status.userRunning}/${status.maxUserRunning}），正在等待空位…（第 ${attempt + 1}/${maxAttempts} 次）"
                            else
                                "无法连接到服务端，正在重试…（第 ${attempt + 1}/${maxAttempts} 次）",
                            "userQueued" to (status?.userQueued ?: 0),
                            "userRunning" to (status?.userRunning ?: 0),
                            "globalQueued" to (status?.globalQueued ?: 0),
                            "globalRunning" to (status?.globalRunning ?: 0),
                        ),
                    )
                    scheduleAdmissionRetry(attempt + 1, maxAttempts, status?.retryAfterSec ?: 30)
                } else {
                    // Max retries exhausted — ask user whether to keep retrying
                    dispatchToWeb(
                        "admission_retry_ask",
                        mapOf(
                            "attempt" to attempt,
                            "maxAttempts" to maxAttempts,
                            "message" to "已重试 ${maxAttempts} 次仍无法获得服务端资源，是否继续重试？",
                        ),
                    )
                }
            } else {
                // Admitted — proceed with the message
                log.info("Admission retry succeeded, attempt=$attempt")
                dispatchToWeb("admission_granted", mapOf<String, Any>())
                // Continue with the message flow from where we left off
                val snap = synchronized(conversationLock) { inFlightSnapshot } ?: return@executeOnPooledThread
                handleUserMessage(
                    snap.text, snap.mode, snap.modelId, snap.modelSource,
                    snap.contextRefs, snap.images, snap.historyMessages,
                    freshChat = snap.freshChat, maxMode = snap.maxMode,
                    skipUserPersist = true, reuseTurnId = snap.turnId,
                )
            }
        }
    }

    private fun finishConversationAndDrainQueue() {
        val next: PendingUserMessage?
        synchronized(conversationLock) {
            conversationInFlight = false
            inFlightSnapshot = null
            next = pendingUserMessages.removeFirstOrNull()
            if (next != null) {
                conversationInFlight = true
                inFlightSnapshot = next
            } else {
                serverBackoffAttempts = 0
            }
        }
        if (next == null) {
            dispatchToWeb("conversation_running", mapOf("running" to false))
            dispatchMessageQueueSnapshot()
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            handleUserMessage(
                next.text,
                next.mode,
                next.modelId,
                next.modelSource,
                next.contextRefs,
                next.images,
                next.historyMessages,
                freshChat = next.freshChat,
                maxMode = next.maxMode,
                skipUserPersist = true,
                reuseTurnId = next.turnId,
            )
        }
    }

    /** Stop in-flight SSE, drop adapter, and clear the active session pointer. */
    private fun beginNewChatSession() {
        pendingFreshChat = true
        synchronized(conversationLock) {
            pendingUserMessages.clear()
            conversationInFlight = false
        }
        dispatchMessageQueueSnapshot()
        dispatchToWeb("conversation_running", mapOf("running" to false))
        abortActiveConversation()
        eventBus.clearBuffer()
        val replayBaseline = eventBus.currentSeq()
        sessionHandle = null
        dispatchToWeb(
            "chat_reset",
            mapOf("replayBaseline" to replayBaseline),
        )
        dispatchToWeb("session_switched", mapOf("id" to ""))
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchToWeb(
            "session_messages",
            mapOf(
                "sessionId" to "",
                "messages" to emptyList<Map<String, Any?>>(),
                "abnormalTermination" to false,
                "hasCheckpoint" to false,
                "freshChat" to true,
            ),
        )
    }

    /**
     * After deploy drain, re-attach to the durable run queue stream (P2b) on any healthy pod.
     */
    private fun handleAttachDurableRun(runId: String) {
        val handle = sessionHandle ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            val afterSeq = fetchRunLastSeq(runId).coerceAtLeast(durableRunLastSeq)
            dispatchToWeb("run_reattaching", mapOf("runId" to runId, "afterSeq" to afterSeq))
            sessionStore.updateMeta(handle) { meta ->
                meta.running = true
                meta.abnormalTermination = false
            }
            val assistantBuilder = StringBuilder()
            client.attachRunStream(
                runId,
                afterSeq,
                object : ConversationClient.Listener {
                    override fun onRunReclaimed(payload: com.fasterxml.jackson.databind.JsonNode) {
                        dispatchToWeb("run_reclaimed", mapper.treeToValue(payload, Map::class.java) as Map<String, Any?>)
                    }

                    override fun onDelta(text: String) {
                        assistantBuilder.append(text)
                        dispatchToWeb("delta", mapOf("text" to text))
                    }

                    override fun onDone(
                        reason: String,
                        payload: com.fasterxml.jackson.databind.JsonNode,
                    ) {
                        dispatchToWeb("done", mapOf("reason" to reason))
                        if (reason == "final" || reason == "failed" || reason == "stopped" || reason == "max_steps") {
                            val fullResponse = assistantBuilder.toString()
                            if (fullResponse.isNotEmpty()) {
                                sessionStore.appendMessage(handle, "assistant", fullResponse)
                            }
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = false
                                meta.abnormalTermination = false
                            }
                            dispatchSessionList()
                        }
                    }

                    override fun onClosed() {
                        val isRunning = sessionHandle?.meta?.running == true
                        if (isRunning) {
                            sessionStore.updateMeta(handle) { meta ->
                                meta.running = false
                                meta.abnormalTermination = true
                            }
                            graphStateStore?.let { dispatchSessionInterrupted(handle, it) }
                        }
                    }
                },
            )
        }
    }

    private fun fetchRunLastSeq(runId: String): Int {
        return try {
            val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
            val req = http.get("/v1/conversation/runs/$runId/status")
            http.client().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return durableRunLastSeq
                val body = resp.body?.string() ?: return durableRunLastSeq
                val node = mapper.readTree(body)
                node.path("data").path("lastSeq").asInt(durableRunLastSeq)
            }
        } catch (e: Exception) {
            log.warn("fetchRunLastSeq failed: ${e.message}")
            durableRunLastSeq
        }
    }

    private fun abortActiveConversation() {
        activeStreamGeneration++
        durableRunId = null
        durableRunLastSeq = 0
        legacyAdapter = null
        val sid = sessionHandle?.meta?.id
        if (!sid.isNullOrBlank()) {
            client.stop(sid)
        } else {
            client.cancelActiveStream()
        }
    }

    private fun dispatchSessionInterrupted(
        handle: SessionStore.SessionHandle,
        graphStateStore: io.codepilot.plugin.tools.GraphStateStore?,
    ) {
        sessionStore.persistAbnormalCloseSnapshot(handle, graphStateStore?.snapshot())
        val assessment = sessionStore.assessRecovery(handle)
        dispatchToWeb(
            "session_interrupted",
            mapOf(
                "sessionId" to handle.meta.id,
                "hasCheckpoint" to assessment.hasLocalCheckpoint,
                "hasContinuationToken" to assessment.hasContinuationToken,
                "recoveryMode" to assessment.mode,
            ),
        )
    }

    private fun handleListSessions() {
        dispatchSessionList()
        // Do not reload session_messages here — that overwrites the live v2 chat tree
        // mid-turn and causes duplicate / truncated history. Messages load on switch_session
        // and initial page load only.
    }

    private fun handleSwitchSession(sessionId: String) {
        pendingFreshChat = false
        synchronized(conversationLock) {
            pendingUserMessages.clear()
            conversationInFlight = false
        }
        dispatchToWeb("conversation_running", mapOf("running" to false))
        abortActiveConversation()
        val handle =
            sessionStore.resolve(workspaceHash, sessionId) ?: run {
                log.warn("Session not found: $sessionId")
                return
            }
        sessionHandle = handle
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
        dispatchBranchTree(handle.meta.id)
    }

    private fun handleDeleteSession(sessionId: String) {
        val currentId = sessionHandle?.meta?.id
        if (currentId != null && sessionId == currentId) {
            // Deleting current session → reset to new (no disk session)
            abortActiveConversation()
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

    private fun contextBudgetLimit(): Int =
        settings.state.contextBudgetTokens.coerceIn(4096, 512_000)

    private fun budgetBreakdown(
        rulesText: String,
        memoryText: String,
        contextRefs: List<Map<String, Any?>>,
        recentMessages: List<Map<String, Any?>>,
        totalUsed: Int,
        estimatedExtra: Int = 0,
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
        val total = contextBudgetLimit()
        return mapOf("total" to total, "used" to totalUsed, "estimated" to estimatedExtra, "buckets" to buckets)
    }

    private fun thinkingTransportFor(
        modelId: String?,
        maxMode: Boolean,
        thinkingMode: String?,
    ): String? {
        if (modelId.isNullOrBlank()) return null
        val id = modelId.lowercase()
        val mode = thinkingMode?.trim()?.lowercase()
        if (!maxMode && mode.isNullOrBlank()) return null
        if (id.contains("claude") &&
            (id.contains("sonnet-4") || id.contains("opus-4") || id.contains("3-7") || id.contains("thinking"))
        ) {
            return "anthropic-extra"
        }
        if (id.contains("reasoning") || id.contains("thinking") ||
            id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") ||
            id.contains("gpt-5")
        ) {
            return "openai-reasoning"
        }
        return null
    }

    private fun routeModel(
        requestedModelId: String?,
        text: String,
        mode: String,
        hasImages: Boolean,
        maxMode: Boolean,
    ): Map<String, Any?> {
        if (maxMode && requestedModelId != null && requestedModelId != "auto") {
            val current = modelCatalog.find { it["id"] == requestedModelId }
            val currentTier = current?.get("tier") as? String
            val currentCaps = current?.get("capabilities") as? Collection<*> ?: emptyList<Any>()
            val needsUpgrade =
                current == null ||
                    currentTier != "PREMIUM" ||
                    (hasImages && !currentCaps.contains("VISION"))
            if (needsUpgrade) {
                val upgraded =
                    modelCatalog.firstOrNull {
                        val caps = it["capabilities"] as? Collection<*> ?: emptyList<Any>()
                        it["tier"] == "PREMIUM" && (!hasImages || caps.contains("VISION"))
                    }
                if (upgraded != null) {
                    val upgradedId = upgraded["id"]?.toString()
                    dispatchToWeb(
                        "model.routed",
                        mapOf(
                            "modelId" to upgradedId,
                            "name" to upgraded["name"],
                            "tier" to upgraded["tier"],
                            "reason" to "Max mode: upgraded to premium model",
                            "maxMode" to true,
                            "thinkingMode" to "high",
                            "thinkingTransport" to thinkingTransportFor(upgradedId, true, "high"),
                        ),
                    )
                    return upgraded
                }
            }
            if (current != null) return current
        }
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
        val chosenId = chosen["id"]?.toString()
        val routedThinking = if (maxMode) "high" else null
        dispatchToWeb(
            "model.routed",
            mapOf(
                "modelId" to chosenId,
                "name" to chosen["name"],
                "tier" to chosen["tier"],
                "reason" to if (maxMode) "Max mode" else "Auto: $desiredTier",
                "maxMode" to maxMode,
                "thinkingMode" to routedThinking,
                "thinkingTransport" to thinkingTransportFor(chosenId, maxMode, routedThinking),
            ),
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
        val record =
            mapOf(
                "ts" to System.currentTimeMillis(),
                "sessionId" to sessionId,
                "turnId" to turnId,
                "modelId" to modelId,
                "tier" to tier,
                "inputTokens" to inputTokens,
                "outputTokens" to outputTokens,
                "costUsd" to cost,
            )
        usageRecords.add(record)
        syncUsageRecordToBackend(record)
        dispatchUsage()
        dispatchSessionCost(sessionId)
        emitTurnMetrics(turnId, modelId, inputTokens, outputTokens, cost, tier)
    }

    private fun dispatchSessionCost(sessionId: String) {
        val sessionRecords = usageRecords.filter { it["sessionId"] == sessionId }
        if (sessionRecords.isEmpty()) return
        val totalInput = sessionRecords.sumOf { (it["inputTokens"] as? Number)?.toInt() ?: 0 }
        val totalOutput = sessionRecords.sumOf { (it["outputTokens"] as? Number)?.toInt() ?: 0 }
        val totalCost = sessionRecords.sumOf { (it["costUsd"] as? Number)?.toDouble() ?: 0.0 }
        val lastModel = sessionRecords.lastOrNull()?.get("modelId")?.toString()
        SwingUtilities.invokeLater {
            dispatchToWeb(
                "session_cost",
                mapOf(
                    "messageCount" to sessionRecords.size,
                    "totalInputTokens" to totalInput,
                    "totalOutputTokens" to totalOutput,
                    "estimatedCostUsd" to totalCost,
                    "modelId" to lastModel,
                ),
            )
        }
    }

    private fun emitTurnMetrics(
        turnId: String,
        modelId: String,
        inputTokens: Int,
        outputTokens: Int,
        costUsd: Double,
        tier: String,
    ) {
        eventBus.emit(
            turnId,
            turnId,
            "turn.metrics",
            mapOf(
                "inputTokens" to inputTokens,
                "outputTokens" to outputTokens,
                "costUsd" to costUsd,
                "modelId" to modelId,
                "tier" to tier,
            ),
        )
    }

    private fun syncUsageRecordToBackend(record: Map<String, Any?>) {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                http.client().newCall(http.postJson("/v1/usage/record", record)).execute().use { /* best-effort */ }
            } catch (e: Exception) {
                log.warn("[Usage] record sync failed: ${e.message}")
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun mergeUsageBuckets(
        local: Map<String, Map<String, Any>>,
        remote: Map<String, Map<String, Any>>,
    ): Map<String, Map<String, Any>> {
        val out = local.toMutableMap()
        for ((key, rb) in remote) {
            val lb = out[key]
            if (lb == null) {
                out[key] = rb
            } else {
                out[key] =
                    mapOf(
                        "count" to ((lb["count"] as? Number)?.toInt() ?: 0) + ((rb["count"] as? Number)?.toInt() ?: 0),
                        "inputTokens" to ((lb["inputTokens"] as? Number)?.toInt() ?: 0) + ((rb["inputTokens"] as? Number)?.toInt() ?: 0),
                        "outputTokens" to ((lb["outputTokens"] as? Number)?.toInt() ?: 0) + ((rb["outputTokens"] as? Number)?.toInt() ?: 0),
                        "costUsd" to ((lb["costUsd"] as? Number)?.toDouble() ?: 0.0) + ((rb["costUsd"] as? Number)?.toDouble() ?: 0.0),
                    )
            }
        }
        return out
    }

    private fun fetchRemoteUsageSummary(): Triple<Map<String, Map<String, Any>>, List<Map<String, Any?>>, String?>? {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return null
        return try {
            val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
            http.client().newCall(http.get("/v1/usage/summary")).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                val data = mapper.readTree(body).path("data")
                val byDay = mapper.convertValue(data.path("byDay"), Map::class.java) as Map<String, Map<String, Any>>
                val byModel = mapper.convertValue(data.path("byModel"), Map::class.java) as Map<String, Map<String, Any>>
                val warnings = data.path("quotaWarnings")
                val backend = data.path("backend").takeIf { !it.isMissingNode && !it.isNull }?.asText()
                Triple(
                    mapOf(
                        "byDay" to byDay,
                        "byModel" to byModel,
                    ),
                    if (warnings.isArray) warnings.map { mapper.convertValue(it, Map::class.java) as Map<String, Any?> } else emptyList(),
                    backend,
                )
            }
        } catch (e: Exception) {
            log.warn("[Usage] summary fetch failed: ${e.message}")
            null
        }
    }

    private fun fetchPersistBackend(statusPath: String): String? {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return null
        return try {
            val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
            http.client().newCall(http.get(statusPath)).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                val backend = mapper.readTree(body).path("data").path("backend").asText("")
                backend.ifBlank { null }
            }
        } catch (e: Exception) {
            log.debug("[Persist] $statusPath failed: ${e.message}")
            null
        }
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
        val localByDay = aggregate { day(it["ts"] as? Long ?: 0L) }
        val localByModel = aggregate { it["modelId"]?.toString() ?: "default" }
        ApplicationManager.getApplication().executeOnPooledThread {
            val remote = fetchRemoteUsageSummary()
            @Suppress("UNCHECKED_CAST")
            val byDay =
                if (remote != null) mergeUsageBuckets(localByDay, (remote.first["byDay"] as? Map<String, Map<String, Any>>) ?: emptyMap()) else localByDay
            @Suppress("UNCHECKED_CAST")
            val byModel =
                if (remote != null) mergeUsageBuckets(localByModel, (remote.first["byModel"] as? Map<String, Map<String, Any>>) ?: emptyMap()) else localByModel
            val payload =
                mutableMapOf<String, Any>(
                    "byDay" to byDay,
                    "byModel" to byModel,
                    "records" to usageRecords.takeLast(100),
                )
            if (remote != null && remote.second.isNotEmpty()) {
                payload["quotaWarnings"] = remote.second
            }
            if (remote != null) {
                payload["persisted"] = true
                remote.third?.let { payload["backend"] = it }
            }
            SwingUtilities.invokeLater {
                dispatchToWeb("usage.update", payload)
            }
        }
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

    private fun handleContextAddRef(payload: com.fasterxml.jackson.databind.JsonNode) {
        val filePath = payload.path("filePath").asText("").trim().ifBlank { return }
        val startLine = payload.path("startLine").asInt(1).coerceAtLeast(1)
        val endLine = payload.path("endLine").asInt(startLine).coerceAtLeast(startLine)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val vfs = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                val vf =
                    vfs.findFileByPath(filePath)
                        ?: project.basePath?.let { base -> vfs.findFileByPath("$base/$filePath".replace("//", "/")) }
                if (vf == null || !vf.isValid) return@executeOnPooledThread
                val lines = String(vf.contentsToByteArray()).lines()
                val slice =
                    lines
                        .drop((startLine - 1).coerceAtMost(lines.size))
                        .take((endLine - startLine + 1).coerceAtLeast(1))
                        .joinToString("\n")
                val display =
                    if (startLine == endLine) "${vf.name}:$startLine" else "${vf.name}:$startLine-$endLine"
                val id = java.util.UUID.randomUUID().toString()
                storeContext(id, slice)
                SwingUtilities.invokeLater {
                    dispatchToWeb(
                        "context_added",
                        mapOf(
                            "id" to id,
                            "type" to "code",
                            "display" to display,
                            "filePath" to vf.path,
                            "language" to (vf.extension ?: ""),
                            "startLine" to startLine,
                            "endLine" to endLine,
                        ),
                    )
                }
            } catch (e: Exception) {
                log.warn("[Context] add_ref failed for $filePath: ${e.message}")
            }
        }
    }

    private fun handleContextEstimate(payload: com.fasterxml.jackson.databind.JsonNode) {
        val refs =
            payload.path("contextRefs").mapNotNull { node ->
                if (node.isMissingNode) return@mapNotNull null
                mapOf(
                    "id" to node.path("id").asText(""),
                    "display" to node.path("display").asText(""),
                    "type" to node.path("type").asText("file"),
                    "filePath" to node.path("filePath").asText(""),
                )
            }
        val chipTokens = refs.sumOf { io.codepilot.plugin.session.TokenEstimator.countTokens(it["display"] as String) }
        val total = contextBudgetLimit()
        dispatchToWeb(
            "context_budget",
            mapOf(
                "current" to 0,
                "total" to total,
                "estimated" to chipTokens,
                "breakdown" to budgetBreakdown("", "", refs, emptyList(), 0, chipTokens),
            ),
        )
    }

    private fun handleBgSubmit(payload: com.fasterxml.jackson.databind.JsonNode) {
        val title = payload.path("title").asText("")
        val prompt = payload.path("prompt").asText("").ifBlank { return }
        val result = runCatching { bgManager().submit(title, prompt) }
        result.onFailure { dispatchToWeb("bg.error", mapOf("message" to (it.message ?: "failed to submit background task"))) }
        result.onSuccess { task -> syncBackgroundTaskToCloud(task) }
        handleBgList()
    }

    private fun syncBackgroundTaskToCloud(task: io.codepilot.plugin.background.BackgroundTaskManager.Task) {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                val req =
                    http.postJson(
                        "/v1/background-agents",
                        mapOf(
                            "prompt" to task.prompt,
                            "worktreePath" to task.worktreePath,
                            "title" to task.title,
                            "localTaskId" to task.id,
                        ),
                    )
                http.client().newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val body = resp.body?.string() ?: return@use
                    val cloudId = mapper.readTree(body).path("data").path("taskId").asText("")
                    if (cloudId.isNotBlank()) {
                        bgCloudIds[task.id] = cloudId
                        syncCloudTaskStatus(task.id, task.status, task.title)
                    }
                }
            } catch (e: Exception) {
                log.warn("[BG] cloud sync failed: ${e.message}")
            }
        }
    }

    private fun syncCloudTaskStatus(localId: String, status: String, title: String?) {
        val cloudId = bgCloudIds[localId] ?: return
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                val patchBody =
                    mutableMapOf<String, Any?>("status" to status)
                if (!title.isNullOrBlank()) patchBody["title"] = title
                val url = (baseUrl.trimEnd('/') + "/v1/background-agents/$cloudId").toHttpUrl()
                val req =
                    okhttp3.Request
                        .Builder()
                        .url(url)
                        .patch(
                            mapper.writeValueAsBytes(patchBody).toRequestBody(
                                "application/json; charset=utf-8".toMediaType(),
                            ),
                        ).header("Accept", "application/json")
                        .build()
                http.client().newCall(req).execute().use { /* best-effort */ }
            } catch (e: Exception) {
                log.debug("[BG] cloud status sync: ${e.message}")
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun fetchCloudBackgroundTasks(): List<Map<String, Any?>> {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return emptyList()
        return try {
            val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
            http.client().newCall(http.get("/v1/background-agents")).execute().use { resp ->
                if (!resp.isSuccessful) return emptyList()
                val body = resp.body?.string() ?: return emptyList()
                val data = mapper.readTree(body).path("data")
                if (!data.isArray) return emptyList()
                data.mapNotNull { node ->
                    val cloudId = node.path("id").asText("")
                    if (cloudId.isBlank()) return@mapNotNull null
                    val localId = node.path("localTaskId").asText("")
                    if (localId.isNotBlank() && bgCloudIds.containsKey(localId)) return@mapNotNull null
                    mapOf(
                        "id" to "cloud-$cloudId",
                        "title" to node.path("title").asText("Cloud · ${cloudId.take(8)}"),
                        "prompt" to node.path("prompt").asText(""),
                        "status" to node.path("status").asText("queued"),
                        "worktreePath" to node.path("worktreePath").asText(""),
                        "branchName" to "cloud",
                        "createdAt" to System.currentTimeMillis(),
                        "source" to "cloud",
                        "cloudId" to cloudId,
                    )
                }
            }
        } catch (e: Exception) {
            log.warn("[BG] cloud list failed: ${e.message}")
            emptyList()
        }
    }

    private fun handleBgList() {
        val baseUrl = settings.state.backendBaseUrl.trim()
        val localTasks =
            bgManager().list().map { task ->
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
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val cloud = fetchCloudBackgroundTasks()
            val localIds = localTasks.map { it["id"] }.toSet()
            val merged = localTasks + cloud.filter { it["id"] !in localIds }
            val persistBackend =
                if (baseUrl.isNotBlank()) fetchPersistBackend("/v1/background-agents/status") else null
            SwingUtilities.invokeLater {
                dispatchToWeb(
                    "bg.tasks.update",
                    buildMap {
                        put("tasks", merged)
                        put("cloudSync", baseUrl.isNotBlank())
                        put("cloudCount", cloud.size)
                        persistBackend?.let { put("persistBackend", it) }
                    },
                )
            }
        }
    }

    private fun cancelCloudBackgroundTask(cloudId: String) {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank() || cloudId.isBlank()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                val url = (baseUrl.trimEnd('/') + "/v1/background-agents/$cloudId").toHttpUrl()
                val req =
                    okhttp3.Request
                        .Builder()
                        .url(url)
                        .delete()
                        .header("Accept", "application/json")
                        .build()
                http.client().newCall(req).execute().use { resp ->
                    log.info("[BG] cloud cancel $cloudId -> HTTP ${resp.code}")
                }
            } catch (e: Exception) {
                log.warn("[BG] cloud cancel failed: ${e.message}")
            }
        }
    }

    private fun handleBgCancel(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("")
        if (id.startsWith("cloud-")) {
            cancelCloudBackgroundTask(id.removePrefix("cloud-"))
        } else {
            bgManager().cancel(id)
        }
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

    private fun handleBgRespond(payload: com.fasterxml.jackson.databind.JsonNode) {
        val id = payload.path("id").asText("")
        val answer = payload.path("answer").asText("")
        if (id.isBlank() || answer.isBlank()) return
        if (id.startsWith("cloud-")) {
            patchCloudBackgroundTask(
                id.removePrefix("cloud-"),
                mapOf("status" to "running", "outputs" to mapOf("userAnswer" to answer)),
            )
        } else {
            bgManager().respond(id, answer)
        }
        handleBgList()
    }

    private fun patchCloudBackgroundTask(cloudId: String, body: Map<String, Any?>) {
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank() || cloudId.isBlank()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                val url = (baseUrl.trimEnd('/') + "/v1/background-agents/$cloudId").toHttpUrl()
                val req =
                    okhttp3.Request
                        .Builder()
                        .url(url)
                        .patch(
                            mapper.writeValueAsBytes(body).toRequestBody(
                                "application/json; charset=utf-8".toMediaType(),
                            ),
                        ).header("Accept", "application/json")
                        .build()
                http.client().newCall(req).execute().use { resp ->
                    log.info("[BG] cloud patch $cloudId -> HTTP ${resp.code}")
                }
            } catch (e: Exception) {
                log.warn("[BG] cloud patch failed: ${e.message}")
            }
        }
    }

    private fun handleUsageSetQuota(payload: com.fasterxml.jackson.databind.JsonNode) {
        val userId = payload.path("userId").asText("default")
        val limit = payload.path("dailyLimitUsd").asDouble(0.0)
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) return
        ApplicationManager.getApplication().executeOnPooledThread {
            runCatching {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                http.client().newCall(http.postJson("/v1/usage/quota", mapOf("userId" to userId, "dailyLimitUsd" to limit))).execute().use { /* best-effort */ }
            }.onFailure { log.warn("[Usage] set quota failed: ${it.message}") }
            SwingUtilities.invokeLater { dispatchUsage() }
        }
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
                val shareId = data.path("shareId").asText("")
                val rawUrl = data.path("url").asText("")
                val base = settings.state.backendBaseUrl.trim().trimEnd('/')
                val absoluteUrl =
                    when {
                        rawUrl.startsWith("http://") || rawUrl.startsWith("https://") -> rawUrl
                        rawUrl.startsWith("/") && base.isNotBlank() -> "$base$rawUrl"
                        shareId.isNotBlank() && base.isNotBlank() -> "$base/v1/share/$shareId"
                        else -> rawUrl
                    }
                val backend = data.path("backend").asText("").ifBlank { null }
                mapOf(
                    "ok" to true,
                    "url" to absoluteUrl,
                    "shareId" to shareId,
                    "expiresAt" to data.path("expiresAt").asText(""),
                    "source" to "cloud",
                ) + (backend?.let { mapOf("backend" to it) } ?: emptyMap())
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

    private fun handleShareStatus() {
        val baseUrl = settings.state.backendBaseUrl.trim()
        ApplicationManager.getApplication().executeOnPooledThread {
            val backend = if (baseUrl.isNotBlank()) fetchPersistBackend("/v1/share/status") else null
            SwingUtilities.invokeLater {
                dispatchToWeb(
                    "share.status.result",
                    mapOf(
                        "configured" to baseUrl.isNotBlank(),
                        "backend" to (backend ?: "file"),
                    ),
                )
            }
        }
    }

    private fun handleShareGet(payload: com.fasterxml.jackson.databind.JsonNode) {
        val shareId = payload.path("shareId").asText("").trim()
        if (shareId.isBlank()) {
            dispatchToWeb("share.get.result", mapOf("ok" to false, "error" to "missing shareId"))
            return
        }
        val baseUrl = settings.state.backendBaseUrl.trim()
        if (baseUrl.isBlank()) {
            dispatchToWeb("share.get.result", mapOf("ok" to false, "error" to "backend not configured"))
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val result =
                runCatching {
                    val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                    val url = (baseUrl.trimEnd('/') + "/v1/share/$shareId").toHttpUrl()
                    http.client().newCall(http.get(url.toString())).execute().use { resp ->
                        if (!resp.isSuccessful) error("HTTP ${resp.code}")
                        val body = resp.body?.string() ?: "{}"
                        val data = mapper.readTree(body).path("data")
                        if (!data.path("found").asBoolean(false)) {
                            mapOf("ok" to false, "error" to "not found", "expired" to data.path("expired").asBoolean(false))
                        } else {
                            mapOf(
                                "ok" to true,
                                "shareId" to shareId,
                                "title" to data.path("title").asText(""),
                                "format" to data.path("format").asText("markdown"),
                                "content" to data.path("content").asText(""),
                                "expiresAt" to data.path("expiresAt").asText(""),
                                "url" to data.path("url").asText(""),
                            )
                        }
                    }
                }.getOrElse { mapOf("ok" to false, "error" to (it.message ?: "fetch failed")) }
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) dispatchToWeb("share.get.result", result)
            }
        }
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
        val activeId =
            if (pendingFreshChat) "" else (sessionHandle?.meta?.id ?: "")
        dispatchToWeb("session_list", mapOf("sessions" to sessions, "activeSessionId" to activeId))
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
        if (pendingFreshChat) {
            dispatchToWeb(
                "session_messages",
                mapOf(
                    "sessionId" to "",
                    "messages" to emptyList<Map<String, Any?>>(),
                    "abnormalTermination" to false,
                    "hasCheckpoint" to false,
                    "freshChat" to true,
                ),
            )
            return
        }
        val handle = sessionHandle
        if (handle != null) {
            // Load completed steps to rebuild toolCalls for each assistant message
            val steps = sessionStore.readSteps(handle)
            val envelopes = sessionStore.readEnvelopes(handle)
            val rawMessages = sessionStore.readMessages(handle)
            val lastAssistantIdx =
                rawMessages.indexOfLast { (it["role"] ?: "") == "assistant" }
            val messages =
                rawMessages.mapIndexed { msgIdx, msg ->
                    val m = mutableMapOf<String, Any?>(
                        "role" to (msg["role"] ?: "unknown"),
                        "content" to (msg["content"] ?: ""),
                    )
                    // Preserve contextRefs if present
                    if (msg["contextRefs"] != null) m["contextRefs"] = msg["contextRefs"]
                    if (msg["images"] != null) m["images"] = msg["images"]
                    if (msg["turnId"] != null) m["turnId"] = msg["turnId"]
                    if (msg["planSteps"] != null) m["planSteps"] = msg["planSteps"]
                    if (msg["agentSteps"] != null) m["agentSteps"] = msg["agentSteps"]
                    // Preserve toolCall info if present
                    if (msg["toolCall"] != null) m["toolCall"] = msg["toolCall"]
                    // Preserve ts (timestamp) for display
                    if (msg["ts"] != null) m["ts"] = msg["ts"]
                    // Restore toolCalls: merge only steps belonging to this message's tools (avoid cross-turn bleed)
                    if (msg["role"] == "assistant") {
                        @Suppress("UNCHECKED_CAST")
                        val persisted = msg["toolCalls"] as? List<Map<String, Any>>
                        if (!persisted.isNullOrEmpty()) {
                            val ids =
                                persisted.mapNotNull { it["id"]?.toString() }
                                    .filter { it.isNotEmpty() }
                                    .toSet()
                            val relevant = steps.filter { (it["toolCallId"] as? String) in ids }
                            val toolCalls = sessionStore.mergeToolCallsPersisted(persisted, relevant)
                            if (toolCalls.isNotEmpty()) {
                                m["toolCalls"] = toolCalls
                            }
                        } else if (msgIdx == lastAssistantIdx && steps.isNotEmpty()) {
                            val msgTurnId = msg["turnId"]?.toString()
                            val relevant =
                                if (!msgTurnId.isNullOrBlank()) {
                                    steps.filter { it["turnId"]?.toString() == msgTurnId }
                                } else {
                                    steps
                                }
                            val toolCalls = sessionStore.mergeToolCallsFromSteps(relevant)
                            if (toolCalls.isNotEmpty()) {
                                m["toolCalls"] = toolCalls
                            }
                        } else if (msg["toolCalls"] != null) {
                            m["toolCalls"] = msg["toolCalls"]
                        }
                    }
                    m.toMap()
                }
            val assessment = sessionStore.assessRecovery(handle)
            dispatchToWeb(
                "session_messages",
                mapOf(
                    "sessionId" to handle.meta.id,
                    "messages" to messages,
                    "envelopes" to envelopes,
                    "envelopeSeq" to eventBus.currentSeq(),
                    "abnormalTermination" to (handle.meta.abnormalTermination ?: false),
                    "hasCheckpoint" to assessment.hasLocalCheckpoint,
                    "hasContinuationToken" to assessment.hasContinuationToken,
                    "recoveryMode" to assessment.mode,
                ),
            )
            dispatchSessionCost(handle.meta.id)
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

    private fun dispatchAppLocale() {
        dispatchToWeb(
            "app_locale",
            mapOf("locale" to LocaleHelper.normalize(settings.state.preferredLocale)),
        )
    }

    private fun handleSetPreferredLocale(payload: com.fasterxml.jackson.databind.JsonNode) {
        val normalized = LocaleHelper.normalize(payload.path("locale").asText(null))
        settings.update { it.preferredLocale = normalized }
        dispatchAppLocale()
    }

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

        // No saved session → optional dev-token bypass for local builds
        if (!hasToken && !hasRefreshToken) {
            if (hasDevToken) {
                dispatchToWeb("auth_state", mapOf("authenticated" to true))
                handleFetchModels()
            } else {
                dispatchToWeb("auth_state", mapOf("authenticated" to false))
            }
            return
        }

        // We have an access token and/or refresh token (persisted from a prior sign-in).
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
                        dispatchToWeb("auth_methods", emptyAuthMethods())
                    } else {
                        val m =
                            result.data ?: io.codepilot.plugin.auth.AuthService
                                .Methods()
                        log.info(
                            "[Auth] Discover success: oidc=${m.oidc}, hmacBridge=${m.hmacBridge}, dev=${m.dev}, deviceFlow=${m.deviceFlow}",
                        )
                        dispatchToWeb("auth_methods", toAuthMethodsPayload(m))
                    }
                }
            } catch (e: Exception) {
                log.error("[Auth] Discover exception", e)
                dispatchToWeb("auth_methods", emptyAuthMethods())
            }
        }
    }

    private fun emptyAuthMethods(): Map<String, Any> =
        mapOf(
            "oidc" to false,
            "hmacBridge" to false,
            "dev" to false,
            "deviceFlow" to false,
            "devUi" to settings.isDevLoginUiEnabled(),
        )

    private fun toAuthMethodsPayload(m: io.codepilot.plugin.auth.AuthService.Methods): Map<String, Any> {
        val devUi = settings.isDevLoginUiEnabled()
        return mapOf(
            "oidc" to m.oidc,
            "hmacBridge" to false,
            "dev" to (m.dev && devUi),
            "deviceFlow" to m.deviceFlow,
            "devUi" to devUi,
        )
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
                        handleFetchModels()
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
                        handleFetchModels()
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
                        handleFetchModels()
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
            val continuationToken =
                graphStateStore.snapshot().path("continuationToken").asText(null)?.trim()?.takeIf { it.isNotBlank() }
            if (continuationToken == null) {
                log.warn("[Plan] continue_run: awaiting but no continuationToken")
                return
            }
            val payload =
                mapOf(
                    "sessionId" to sid,
                    "mode" to (handle.meta.mode ?: "agent"),
                    "input" to "",
                    "intent" to "answer",
                    "continuationToken" to continuationToken,
                    "graphState" to graphStateStore.snapshot(),
                )
            ApplicationManager.getApplication().executeOnPooledThread {
                client.resume(
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
                            } else if (reason != "deploy_draining") {
                                graphStateStore.clearAwaiting()
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