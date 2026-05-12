package io.codepilot.plugin.toolwindow

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
                    )
                "fetch_models" -> handleFetchModels()
                "stop" -> handleStop()
                "risk_approved" -> handleRiskApproval(payload["approved"]?.asBoolean() ?: false)
                "needs_input_response" -> handleNeedsInputResponse(payload["answer"]?.asText() ?: "")
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
                "at_resolve" -> handleAtResolve(payload["id"]?.asText() ?: return)
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
                        val lang = ref?.get("language") as? String ?: "text"
                        val display = ref?.get("display") as? String ?: "context"
                        val loc = if (ref?.get("startLine") != null) " :${ref["startLine"]}-${ref["endLine"]}" else ""
                        appendLine("Context: $display$loc")
                        appendLine("```$lang")
                        appendLine(fullCode)
                        appendLine("```")
                    }
                    remaining = remaining.substring(end + 1)
                }
            }
        val dispatcher = ToolDispatcher(project, client, handle.meta.id)
        val gatherDispatcher =
            io.codepilot.plugin.tools
                .GatherDispatcher(project, client, handle.meta.id)
        val graphStateStore =
            io.codepilot.plugin.tools
                .GraphStateStore(project, handle.dir)

        ApplicationManager.getApplication().executeOnPooledThread {
            val payload =
                mutableMapOf<String, Any?>(
                    "sessionId" to handle.meta.id,
                    "mode" to mode,
                    "input" to fullText,
                    "intent" to "new",
                )
            if (modelId != null) payload["modelId"] = modelId
            if (modelSource != null) payload["modelSource"] = modelSource
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
                graphStateStore.loadLatest()
                if (graphStateStore.isAwaiting()) {
                    payload["intent"] = "continue"
                    payload["graphState"] = graphStateStore.snapshot()
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
            payload["contexts"] =
                mapOf(
                    "pinned" to emptyList<Any>(),
                    "recent" to
                        lastMessages.takeLast(6).map { msg ->
                            mapOf("role" to msg["role"], "content" to (msg["content"] as? String)?.take(2000))
                        },
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
                            dispatcher.dispatch(payload)
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
                        graphStateStore.applyGraphPlan(payload)
                    }

                    override fun onGraphTransition(payload: com.fasterxml.jackson.databind.JsonNode) {
                        graphStateStore.applyTransition(payload)
                    }

                    override fun onGraphInfoRequest(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // Execute client-side gather requests silently
                        gatherDispatcher.dispatchBatch(payload.path("requests"))
                    }

                    override fun onGraphInfoResult(payload: com.fasterxml.jackson.databind.JsonNode) {
                        graphStateStore.applyInfoResult(payload)
                    }

                    override fun onGraphVerify(payload: com.fasterxml.jackson.databind.JsonNode) {
                        graphStateStore.applyVerify(payload)
                    }

                    override fun onGraphRepairPlan(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // internal only, no UI dispatch
                    }

                    override fun onGraphPhaseDone(payload: com.fasterxml.jackson.databind.JsonNode) {
                        graphStateStore.applyPhaseDone(payload)
                    }

                    override fun onGraphBudgetAlert(payload: com.fasterxml.jackson.databind.JsonNode) {
                        // internal only, no UI dispatch
                    }

                    // ── User-facing plan events (shown in Plan panel) ──
                    override fun onUserPlan(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan", mapper.treeToValue(payload, Map::class.java))

                    override fun onUserPlanProgress(payload: com.fasterxml.jackson.databind.JsonNode) =
                        dispatchToWeb("user_plan_progress", mapper.treeToValue(payload, Map::class.java))

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
                            graphStateStore.applyAwaiting(payload)
                        }
                        // Persist the full assistant response and update session metadata
                        val fullResponse = assistantBuilder.toString()
                        if (fullResponse.isNotEmpty()) {
                            sessionStore.appendMessage(handle, "assistant", fullResponse)
                        }
                        sessionStore.touchLastMessage(handle)
                        dispatchSessionList() // refresh sidebar timestamps
                    }

                    override fun onClosed() {}
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

    private fun handleRiskApproval(approved: Boolean) {
        log.info("Risk approval: $approved")
    }

    private fun handleNeedsInputResponse(answer: String) {
        val sid = sessionHandle?.meta?.id ?: return
        client.submitToolResult(sid, "needs_input", answer, true)
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
                    m.toMap()
                }
            dispatchToWeb("session_messages", mapOf("sessionId" to handle.meta.id, "messages" to messages))
        } else {
            dispatchToWeb("session_messages", mapOf("sessionId" to "", "messages" to emptyList<Map<String, Any?>>()))
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
        val authenticated = hasToken || hasRefreshToken || hasDevToken
        log.info(
            "[Auth] checkAuth: hasToken=$hasToken, hasRefreshToken=$hasRefreshToken, hasDevToken=$hasDevToken, authenticated=$authenticated, devToken=${if (hasDevToken) {
                settings.state.devToken.take(
                    8,
                ) + "..."
            } else {
                "null"
            }}, baseUrl=${settings.state.backendBaseUrl}",
        )
        dispatchToWeb("auth_state", mapOf("authenticated" to authenticated))
        // If authenticated, also trigger model fetch — RefreshOn401Interceptor
        // will silently refresh the access token if it has expired.
        if (authenticated) {
            handleFetchModels()
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
     * Supports @file, @symbol, @terminal, @git, @web patterns.
     */
    private fun handleAtSuggest(query: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val suggestions = mutableListOf<Map<String, String>>()
            val lower = query.lowercase()
            // @file — list files matching the query
            if (lower.isEmpty() || lower.startsWith("file") || lower.startsWith("f")) {
                val root = project.basePath ?: return@executeOnPooledThread
                java.nio.file.Files
                    .walk(
                        java.nio.file.Path
                            .of(root),
                    ).limit(50)
                    .filter {
                        java.nio.file.Files
                            .isRegularFile(it) &&
                            !it.toString().contains("/.git/")
                    }.forEach { path ->
                        val rel = path.toString().removePrefix(root).trimStart('/')
                        if (lower.isEmpty() || rel.lowercase().contains(lower.removePrefix("file").removePrefix("f"))) {
                            suggestions.add(mapOf("id" to "file:$rel", "display" to rel, "type" to "file"))
                        }
                    }
            }
            // @terminal — suggest active terminal sessions
            if (lower.isEmpty() || lower.startsWith("terminal") || lower.startsWith("t")) {
                val sessionManager =
                    io.codepilot.plugin.tools.TerminalSessionManager
                        .getInstance(project)
                suggestions.add(mapOf("id" to "terminal:default", "display" to "Terminal output", "type" to "terminal"))
            }
            // @git — suggest git context
            if (lower.isEmpty() || lower.startsWith("git") || lower.startsWith("g")) {
                suggestions.add(mapOf("id" to "git:diff", "display" to "Git diff (staged)", "type" to "git"))
                suggestions.add(mapOf("id" to "git:log", "display" to "Git recent log", "type" to "git"))
            }
            dispatchToWeb("at_suggestions", mapOf("query" to query, "suggestions" to suggestions.take(20)))
        }
    }

    /**
     * ★ at_resolve: Resolves an @-reference ID to its full content.
     */
    private fun handleAtResolve(id: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val parts = id.split(":", limit = 2)
            if (parts.size < 2) {
                dispatchToWeb("at_resolved", mapOf("id" to id, "content" to "", "error" to "invalid reference"))
                return@executeOnPooledThread
            }
            val (type, ref) = parts[0] to parts[1]
            val content =
                when (type) {
                    "file" -> {
                        try {
                            val vf =
                                io.codepilot.plugin.tools.PathGuard
                                    .resolve(project, ref)
                            String(vf.contentsToByteArray(), java.nio.charset.StandardCharsets.UTF_8)
                        } catch (e: Exception) {
                            "Error reading file: ${e.message}"
                        }
                    }
                    "terminal" -> {
                        val sessionManager =
                            io.codepilot.plugin.tools.TerminalSessionManager
                                .getInstance(project)
                        sessionManager.getRecentOutput(ref, 5000) ?: "(no terminal output)"
                    }
                    "git" -> {
                        try {
                            val cmd =
                                when (ref) {
                                    "diff" -> listOf("git", "diff", "--cached")
                                    "log" -> listOf("git", "log", "--oneline", "-20")
                                    else -> listOf("git", "status", "--short")
                                }
                            val proc = ProcessBuilder(cmd).directory(java.io.File(project.basePath)).start()
                            proc.inputStream
                                .bufferedReader()
                                .readText()
                                .take(8000)
                        } catch (e: Exception) {
                            "Error running git: ${e.message}"
                        }
                    }
                    else -> "Unknown reference type: $type"
                }
            dispatchToWeb("at_resolved", mapOf("id" to id, "content" to content))
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
}
