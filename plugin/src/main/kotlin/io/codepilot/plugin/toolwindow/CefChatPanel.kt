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

    /** Current active session; nullable — only created on first message. */
    private var sessionHandle: SessionStore.SessionHandle? = null

    /** Tool dispatchers for handling tool_call SSE events during both run and resume. */
    private var dispatcher: ToolDispatcher? = null
    private var gatherDispatcher: io.codepilot.plugin.tools.GatherDispatcher? = null
    private var graphStateStore: io.codepilot.plugin.tools.GraphStateStore? = null

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
        // browser is disposed via Disposer.register
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
                    )
                "fetch_models" -> handleFetchModels()
                "stop" -> handleStop()
                "risk_approved" -> handleRiskApproval(payload["approved"]?.asBoolean() ?: false)
                "needs_input_response" -> handleNeedsInputResponse(payload)
                "new_session" -> handleNewSession()
                "list_sessions" -> handleListSessions()
                "switch_session" -> handleSwitchSession(payload["sessionId"]?.asText() ?: return)
                "delete_session" -> handleDeleteSession(payload["sessionId"]?.asText() ?: return)
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
    ) {
        // Ensure a session exists (lazy creation on first message)
        if (sessionHandle == null) {
            sessionHandle = sessionStore.newSession(workspaceHash, mode, modelId, modelSource)
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
        dispatcher = ToolDispatcher(project, client, handle.meta.id, onToolResult = { toolCallId, ok, _ ->
            // Dispatch tool_result_ack to WebUI immediately when tool execution completes
            dispatchToWeb("tool_result_ack", mapOf("toolCallId" to toolCallId, "ok" to ok))
            // Record the tool result step
            sessionStore.appendStep(handle, mapOf(
                "toolCallId" to toolCallId,
                "ok" to ok,
                "ts" to java.time.Instant.now().toString(),
            ))
        })
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
            if (modelId != null) payload["modelId"] = modelId
            if (modelSource != null) payload["modelSource"] = modelSource

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

            // ★ Integration: Inject .codepilotrules into the request payload
            // ProjectRulesLoader reads from .codepilotrules / .codepilotrules.local
            // and is already cached with VFS file-watcher auto-reload
            val projectRules = io.codepilot.plugin.context.ProjectRulesLoader.getRules(project)
            if (projectRules != null) {
                payload["projectRules"] = listOf(projectRules)
            }
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
            payload["policy"] =
                mapOf(
                    "requestCompact" to "auto",
                    "selfCheck" to true,
                    "askPolicy" to "prefer-ask",
                    "contextBudgetTokens" to 24000,
                    "keepRecentMessages" to 6,
                    "maxSteps" to 25,
                )

            // Collect full assistant response for local persistence
            val assistantBuilder = StringBuilder()
            // ★ Guard to prevent duplicate assistant message persistence on double done events
            var assistantPersisted = false

            client.run(
                payload.toMap(),
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

                    override fun onRiskNotice(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("risk_notice", mapper.treeToValue(payload, Map::class.java))

                    override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))

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
                    override fun onUserPlan(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan", mapper.treeToValue(payload, Map::class.java))

                    override fun onUserPlanProgress(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan_progress", mapper.treeToValue(payload, Map::class.java))

                    // ── Interactive Agent events (semantic layer for user-facing steps) ──
                    override fun onAgentThinking(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("agent_thinking", mapper.treeToValue(payload, Map::class.java))

                    override fun onAgentReading(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("agent_reading", mapper.treeToValue(payload, Map::class.java))

                    override fun onAgentWriting(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("agent_writing", mapper.treeToValue(payload, Map::class.java))

                    override fun onAgentRunning(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("agent_running", mapper.treeToValue(payload, Map::class.java))

                    override fun onError(
                        code: Int,
                        message: String,
                    ) = dispatchToWeb("error", mapOf("code" to code, "message" to message))

                    override fun onDone(
                        reason: String,
                        payload: com.fasterxml.jackson.databind.JsonNode,
                    ) {
                        dispatchToWeb("done", mapOf("reason" to reason))
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
                            dispatchSessionList() // refresh sidebar timestamps
                        }
                    }

                    override fun onClosed() {
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
                dispatchToWeb("models_loaded", mapper.treeToValue(data, Map::class.java))
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

    /** Push the full session list (sorted by lastMessageAt desc) to the WebUI. */
    private fun dispatchSessionList() {
        val sessions =
            sessionStore
                .list(workspaceHash)
                .sortedByDescending { it.lastMessageAt ?: it.createdAt }
                .map { meta ->
                    mapOf(
                        "id" to meta.id,
                        "title" to (meta.title ?: "New Chat"),
                        "mode" to meta.mode,
                        "createdAt" to meta.createdAt,
                        "lastMessageAt" to meta.lastMessageAt,
                    )
                }
        dispatchToWeb("session_list", mapOf("sessions" to sessions, "activeSessionId" to (sessionHandle?.meta?.id ?: "")))
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