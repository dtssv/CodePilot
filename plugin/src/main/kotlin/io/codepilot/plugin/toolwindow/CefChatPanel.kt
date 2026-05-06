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
                    payload["mode"]?.asText() ?: "agent"
                )
                "stop" -> handleStop()
                "risk_approved" -> handleRiskApproval(payload["approved"]?.asBoolean() ?: false)
                "needs_input_response" -> handleNeedsInputResponse(payload["answer"]?.asText() ?: "")
                else -> log.warn("Unknown message type from web: $type")
            }
        } catch (e: Exception) {
            log.error("Failed to handle web message: $request", e)
        }
    }

    private fun handleUserMessage(text: String, mode: String) {
        val session = sessionStore.currentSession(project)
        val dispatcher = ToolDispatcher(project, client, session.meta.id)

        ApplicationManager.getApplication().executeOnPooledThread {
            client.run(session.meta.id, text, mode) { eventType, data ->
                dispatchToWeb(eventType, data)
                // Handle tool calls via dispatcher
                if (eventType == "tool_call") {
                    val toolName = (data as? Map<*, *>)?.get("name") as? String
                    val toolArgs = (data as? Map<*, *>)?.get("args")
                    val toolCallId = (data as? Map<*, *>)?.get("id") as? String
                    if (toolName != null && toolCallId != null) {
                        dispatcher.dispatch(toolName, toolArgs, toolCallId)
                    }
                }
            }
        }
    }

    private fun handleStop() {
        val session = sessionStore.currentSession(project)
        client.stop(session.meta.id)
    }

    private fun handleRiskApproval(approved: Boolean) {
        // Forward risk approval to the conversation client
        log.info("Risk approval: $approved")
    }

    private fun handleNeedsInputResponse(answer: String) {
        val session = sessionStore.currentSession(project)
        client.submitToolResult(session.meta.id, "needs_input", answer, true)
    }

    private fun resolveWebUiPath(): String {
        // In production, the built webui is bundled inside the plugin jar/resources
        val resourceUrl = javaClass.getResource("/webui/dist/index.html")
        if (resourceUrl != null) {
            return resourceUrl.toExternalForm()
        }
        // Dev fallback: load from the source directory
        val devPath = Path.of(project.basePath ?: ".", "plugin", "webui", "dist", "index.html")
        return if (devPath.toFile().exists()) {
            devPath.toUri().toString()
        } else {
            "about:blank"
        }
    }
}