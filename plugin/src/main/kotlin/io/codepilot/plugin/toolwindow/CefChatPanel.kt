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
import java.nio.file.Path
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
    private val sessionHandle = sessionStore.newSession((project.basePath ?: project.name).hashCode().toString(16), "agent", null)

    private val panel = JPanel(BorderLayout())

    init {
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
                else -> log.warn("Unknown message type from web: $type")
            }
        } catch (e: Exception) {
            log.error("Failed to handle web message: $request", e)
        }
    }

    private fun handleUserMessage(text: String, mode: String, modelId: String? = null) {
        val dispatcher = ToolDispatcher(project, client, sessionHandle.meta.id)

        ApplicationManager.getApplication().executeOnPooledThread {
            val payload = mutableMapOf<String, Any?>(
                "sessionId" to sessionHandle.meta.id,
                "mode" to mode,
                "input" to text,
                "intent" to "new",
            )
            if (modelId != null) payload["modelId"] = modelId

            client.run(payload.toMap(), object : ConversationClient.Listener {
                override fun onDelta(text: String) = dispatchToWeb("delta", mapOf("text" to text))
                override fun onToolCall(payload: com.fasterxml.jackson.databind.JsonNode) {
                    val data = mapper.treeToValue(payload, Map::class.java)
                    dispatchToWeb("tool_call", data)
                    val toolName = payload.path("name").asText(null)
                    val toolCallId = payload.path("id").asText(null)
                    if (toolName != null && toolCallId != null) {
                        dispatcher.dispatch(payload)
                    }
                }
                override fun onPlan(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("plan", mapper.treeToValue(payload, Map::class.java))
                override fun onPlanDelta(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("plan_delta", mapper.treeToValue(payload, Map::class.java))
                override fun onTaskLedger(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("task_ledger", mapper.treeToValue(payload, Map::class.java))
                override fun onRiskNotice(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("risk_notice", mapper.treeToValue(payload, Map::class.java))
                override fun onNeedsInput(payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("needs_input", mapper.treeToValue(payload, Map::class.java))
                override fun onError(code: Int, message: String) =
                    dispatchToWeb("error", mapOf("code" to code, "message" to message))
                override fun onDone(reason: String, payload: com.fasterxml.jackson.databind.JsonNode) =
                    dispatchToWeb("done", mapOf("reason" to reason))
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

    private fun resolveWebUiPath(): String {
        // In production, the built webui is bundled inside the plugin jar/resources
        val resourceUrl = javaClass.getResource("/webui/dist/index.html")
        if (resourceUrl != null) {
            return resourceUrl.toExternalForm()
        }
        // Dev fallback: load from the source directory
        val devPath = Path.of(project.basePath ?: ".", "plugin", "webui", "dist", "index.html")
        if (devPath.toFile().exists()) {
            return devPath.toUri().toString()
        }
        // WebUI not built — throw to signal fallback to Swing panel
        throw IllegalStateException("WebUI not found. Run 'cd plugin/webui && npm run build' first, or use Swing panel fallback.")
    }
}