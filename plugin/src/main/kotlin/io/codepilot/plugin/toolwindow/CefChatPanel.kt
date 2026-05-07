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

/**
 * JCEF-based chat panel that loads the React WebUI and bridges bidirectional
 * communication via CefMessageRouter.
 *
 * Plugin → Web: executeJavaScript("window.__codepilot_dispatch('eventType', payload)")
 * Web → Plugin: cefQuery({ request: JSON.stringify({type, payload}) })
 */
class CefChatPanel(private val project: Project) : Disposable {

    private val log = logger<CefChatPanel>()
    private val mapper = ObjectMapper()
    private val browser: JBCefBrowser
    private val queryHandler: JBCefJSQuery
    private val sessionStore = SessionStore.getInstance()
    private val client = ConversationClient()
    private val workspaceHash = (project.basePath ?: project.name).hashCode().toString(16)

    /** Current active session; mutable to support session switching. */
    private var sessionHandle: SessionStore.SessionHandle

    private val panel = JPanel(BorderLayout())

    init {
        // Create or reuse the initial session
        sessionHandle = sessionStore.newSession(workspaceHash, "agent", null)

        browser = JBCefBrowser.createBuilder()
            .setEnableOpenDevToolsMenuItem(true)
            .build()

        queryHandler = JBCefJSQuery.create(browser)
        queryHandler.addHandler { request ->
            handleWebMessage(request)
            JBCefJSQuery.Response("ok")
        }

        // Inject the cefQuery bridge function after page load
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser?, frame: org.cef.browser.CefFrame?, httpStatusCode: Int) {
                if (frame?.isMain == true) {
                    injectBridge(cefBrowser!!)
                    // Push session list and current session messages to the WebUI
                    dispatchSessionList()
                    dispatchCurrentSessionInfo()
                    dispatchCurrentSessionMessages()
                }
            }
        }, browser.cefBrowser)

        // Load the WebUI
        val webUiPath = resolveWebUiPath()
        browser.loadURL(webUiPath)

        panel.add(browser.component, BorderLayout.CENTER)
        Disposer.register(this, browser)
    }

    val component: JComponent get() = panel

    /** Dispatch an SSE event to the web UI. */
    fun dispatchToWeb(eventType: String, payload: Any?) {
        val json = mapper.writeValueAsString(payload)
        val script = "window.__codepilot_dispatch && window.__codepilot_dispatch('$eventType', $json);"
        ApplicationManager.getApplication().invokeLater {
            browser.cefBrowser.executeJavaScript(script, "", 0)
        }
    }

    override fun dispose() {
        // browser is disposed via Disposer.register
    }

    // ---- Private ---- //

    private fun injectBridge(cefBrowser: CefBrowser) {
        val injection = """
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
                "user_message" -> handleUserMessage(
                    payload["text"]?.asText() ?: "",
                    payload["mode"]?.asText() ?: "agent",
                    payload["modelId"]?.asText()
                )
                "fetch_models" -> handleFetchModels()
                "stop" -> handleStop()
                "risk_approved" -> handleRiskApproval(payload["approved"]?.asBoolean() ?: false)
                "needs_input_response" -> handleNeedsInputResponse(payload["answer"]?.asText() ?: "")
                "new_session" -> handleNewSession()
                "list_sessions" -> handleListSessions()
                "switch_session" -> handleSwitchSession(payload["sessionId"]?.asText() ?: return)
                "delete_session" -> handleDeleteSession(payload["sessionId"]?.asText() ?: return)
                else -> log.warn("Unknown message type from web: $type")
            }
        } catch (e: Exception) {
            log.error("Failed to handle web message: $request", e)
        }
    }

    private fun handleUserMessage(text: String, mode: String, modelId: String? = null) {
        // Persist user message locally
        sessionStore.appendMessage(sessionHandle, "user", text)
        // Auto-derive title from first user message
        if (sessionHandle.meta.title.isNullOrBlank()) {
            sessionStore.updateMeta(sessionHandle) { meta ->
                meta.title = text.take(50)
            }
        }
        sessionStore.touchLastMessage(sessionHandle)
        // Notify WebUI that user message was persisted
        dispatchToWeb("user_message_saved", mapOf("role" to "user", "content" to text))

        val dispatcher = ToolDispatcher(project, client, sessionHandle.meta.id)

        ApplicationManager.getApplication().executeOnPooledThread {
            val payload = mutableMapOf<String, Any?>(
                "sessionId" to sessionHandle.meta.id,
                "mode" to mode,
                "input" to text,
                "intent" to "new",
            )
            if (modelId != null) payload["modelId"] = modelId

            // Collect full assistant response for local persistence
            val assistantBuilder = StringBuilder()

            client.run(payload.toMap(), object : ConversationClient.Listener {
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
                    sessionStore.savePlan(sessionHandle, data)
                }
                override fun onPlanDelta(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("plan_delta", mapper.treeToValue(payload, Map::class.java))
                override fun onTaskLedger(payload: com.fasterxml.jackson.databind.JsonNode) {
                    val data = mapper.treeToValue(payload, Map::class.java)
                    dispatchToWeb("task_ledger", data)
                    sessionStore.saveLedger(sessionHandle, data)
                }
                override fun onRiskNotice(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("risk_notice", mapper.treeToValue(payload, Map::class.java))
                override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))
                override fun onError(code: Int, message: String) =
                    dispatchToWeb("error", mapOf("code" to code, "message" to message))
                override fun onDone(reason: String, payload: com.fasterxml.jackson.databind.JsonNode) {
                    dispatchToWeb("done", mapOf("reason" to reason))
                    // Persist the full assistant response and update session metadata
                    val fullResponse = assistantBuilder.toString()
                    if (fullResponse.isNotEmpty()) {
                        sessionStore.appendMessage(sessionHandle, "assistant", fullResponse)
                    }
                    sessionStore.touchLastMessage(sessionHandle)
                    dispatchSessionList() // refresh sidebar timestamps
                }
                override fun onClosed() {}
            })
        }
    }

    /** Fetches available models from backend and dispatches to web UI. */
    private fun handleFetchModels() {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                val request = okhttp3.Request.Builder()
                    .url(
                        (io.codepilot.plugin.settings.CodePilotSettings.getInstance()
                            .state.backendBaseUrl.trimEnd('/') + "/v1/models")
                            .toHttpUrl()
                    )
                    .get()
                    .header("Accept", "application/json")
                    .build()
                val response = http.client().newCall(request).execute()
                response.use { resp ->
                    if (resp.isSuccessful) {
                        val body = resp.body?.string() ?: return@use
                        val node = mapper.readTree(body)
                        val data = node.path("data")
                        dispatchToWeb("models_loaded", mapper.treeToValue(data, Map::class.java))
                    } else {
                        log.warn("Failed to fetch models: ${resp.code}")
                    }
                }
            } catch (e: Exception) {
                log.error("Failed to fetch models", e)
            }
        }
    }

    private fun handleStop() {
        client.stop(sessionHandle.meta.id)
    }

    private fun handleRiskApproval(approved: Boolean) {
        log.info("Risk approval: $approved")
    }

    private fun handleNeedsInputResponse(answer: String) {
        client.submitToolResult(sessionHandle.meta.id, "needs_input", answer, true)
    }

    // ---- Session management ---- //

    private fun handleNewSession() {
        sessionHandle = sessionStore.newSession(workspaceHash, "agent", null)
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleListSessions() {
        dispatchSessionList()
    }

    private fun handleSwitchSession(sessionId: String) {
        val handle = sessionStore.resolve(workspaceHash, sessionId) ?: run {
            log.warn("Session not found: $sessionId")
            return
        }
        sessionHandle = handle
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    private fun handleDeleteSession(sessionId: String) {
        if (sessionId == sessionHandle.meta.id) {
            // Deleting current session → switch to a new one
            sessionStore.delete(workspaceHash, sessionId)
            sessionHandle = sessionStore.newSession(workspaceHash, "agent", null)
        } else {
            sessionStore.delete(workspaceHash, sessionId)
        }
        dispatchSessionList()
        dispatchCurrentSessionInfo()
        dispatchCurrentSessionMessages()
    }

    /** Push the full session list (sorted by lastMessageAt desc) to the WebUI. */
    private fun dispatchSessionList() {
        val sessions = sessionStore.list(workspaceHash)
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
        dispatchToWeb("session_list", mapOf("sessions" to sessions, "activeSessionId" to sessionHandle.meta.id))
    }

    /** Push current session metadata. */
    private fun dispatchCurrentSessionInfo() {
        val meta = sessionHandle.meta
        dispatchToWeb("session_switched", mapOf(
            "id" to meta.id,
            "title" to (meta.title ?: "New Chat"),
            "mode" to meta.mode,
            "createdAt" to meta.createdAt,
            "lastMessageAt" to meta.lastMessageAt,
        ))
    }

    /** Push all messages of the current session so the WebUI can restore the chat view. */
    private fun dispatchCurrentSessionMessages() {
        val messages = sessionStore.readMessages(sessionHandle).map { msg ->
            mapOf(
                "role" to (msg["role"] ?: "unknown"),
                "content" to (msg["content"] ?: ""),
            )
        }
        dispatchToWeb("session_messages", mapOf("sessionId" to sessionHandle.meta.id, "messages" to messages))
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
        val tempDir = java.nio.file.Files.createTempDirectory("codepilot-webui")
        // Register cleanup on JVM exit
        Runtime.getRuntime().addShutdownHook(Thread {
            tempDir.toFile().deleteRecursively()
        })

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
                jar.entries().asSequence()
                    .filter { it.name.startsWith("webui/dist/") && !it.isDirectory }
                    .forEach { entry ->
                        val relativePath = entry.name.removePrefix("webui/dist/")
                        val targetFile = tempDir.resolve(relativePath)
                        java.nio.file.Files.createDirectories(targetFile.parent)
                        jar.getInputStream(entry).use { input ->
                            java.nio.file.Files.copy(input, targetFile, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
                        }
                    }
            }
        } else {
            // Non-jar (e.g., file:// in dev mode with exploded classes)
            val baseDir = Path.of(jarUrl.toURI()).parent
            baseDir.toFile().walkTopDown().filter { it.isFile }.forEach { file ->
                val rel = baseDir.relativize(file.toPath())
                val target = tempDir.resolve(rel)
                java.nio.file.Files.createDirectories(target.parent)
                java.nio.file.Files.copy(file.toPath(), target, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            }
        }
        return tempDir
    }

    private fun copyResourceToTemp(classLoader: ClassLoader, resourcePath: String, target: Path) {
        val input = classLoader.getResourceAsStream(resourcePath.removePrefix("/")) ?: return
        java.nio.file.Files.createDirectories(target.parent)
        input.use { java.nio.file.Files.copy(it, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING) }
    }
}