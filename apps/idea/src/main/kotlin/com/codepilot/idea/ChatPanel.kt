package com.codepilot.idea

import com.google.gson.JsonObject
import com.intellij.openapi.diagnostic.logger
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.UIUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.swing.Swing
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.ActionEvent
import javax.swing.AbstractAction
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JTextPane
import javax.swing.KeyStroke
import javax.swing.SwingUtilities
import javax.swing.text.BadLocationException
import javax.swing.text.DefaultCaret
import javax.swing.text.Style
import javax.swing.text.StyleConstants
import javax.swing.text.StyledDocument
import javax.swing.text.html.HTMLDocument
import javax.swing.text.html.HTMLEditorKit

/**
 * The Swing panel rendered inside the `CodePilot` tool window. Holds:
 *   - A scrollable message log (HTML-rendered user / assistant / tool_call / plan / usage rows).
 *   - An input area with a Send / Cancel button.
 *
 * All rendering and I/O hops through the EDT for Swing and coroutines on [Dispatchers.IO] for JSON-RPC.
 */
class ChatPanel(private val project: com.intellij.openapi.project.Project) {

    private val log = logger<ChatPanel>()

    // ----- Subsystem: client -----
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Swing)
    private val client: CodepilotClient?
        get() = CodepilotService.getInstance(project).client()

    private var sessionId: String? = null
    /** Map of in-progress assistant messageId → buffered text (for streaming). */
    private val streamingMessages = mutableMapOf<String, String>()
    /** Map of toolCallId → buffered JSON (for tool_call input streaming). */
    private val streamingToolInputs = mutableMapOf<String, String>()
    /** Most recent plan steps, keyed by session. */
    private var lastPlan: List<PlanStep> = emptyList()

    // ----- UI -----
    private val messagePane = JTextPane().apply {
        contentType = "text/html"
        isEditable = false
        // Update on every change so streaming renders smoothly.
        val caret: DefaultCaret = caret as DefaultCaret
        caret.updatePolicy = DefaultCaret.ALWAYS_UPDATE
        border = BorderFactory.createEmptyBorder(8, 8, 8, 8)
        background = JBColor.background()
    }
    private val scroll = JBScrollPane(messagePane).apply {
        verticalScrollBarPolicy = JBScrollPane.VERTICAL_SCROLLBAR_ALWAYS
        preferredSize = Dimension(640, 360)
    }
    private val inputArea = JBTextArea(4, 60).apply {
        lineWrap = true
        wrapStyleWord = true
        border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(JBColor.border(), 1),
            BorderFactory.createEmptyBorder(6, 6, 6, 6),
        )
        font = UIUtil.getLabelFont()
        // Ctrl+Enter / Cmd+Enter triggers Send.
        getInputMap(JComponent.WHEN_FOCUSED).put(KeyStroke.getKeyStroke("ENTER ctrl"), "send")
        getInputMap(JComponent.WHEN_FOCUSED).put(KeyStroke.getKeyStroke("ENTER meta"), "send")
        actionMap.put("send", object : AbstractAction() {
            override fun actionPerformed(e: ActionEvent?) { sendCurrentInput() }
        })
    }
    private val sendButton = JButton("Send").apply {
        addActionListener { sendCurrentInput() }
        isEnabled = false
    }
    private val cancelButton = JButton("Cancel").apply {
        addActionListener { cancelCurrent() }
        isEnabled = false
    }
    private val newSessionButton = JButton("New Session").apply {
        addActionListener { startNewSession() }
    }
    private val statusLabel = JLabel("Starting…").apply {
        horizontalAlignment = JLabel.LEFT
        border = BorderFactory.createEmptyBorder(2, 8, 2, 8)
        foreground = JBColor.GRAY
    }

    val component: JComponent = buildComponent()

    private fun buildComponent(): JComponent {
        val toolbar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(newSessionButton)
            add(Box.createHorizontalGlue())
        }

        val bottomBar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(Box.createHorizontalGlue())
            add(cancelButton)
            add(Box.createHorizontalStrut(8))
            add(sendButton)
        }

        val south = JPanel(BorderLayout()).apply {
            add(inputArea, BorderLayout.CENTER)
            add(bottomBar, BorderLayout.SOUTH)
        }

        return JPanel(BorderLayout()).apply {
            add(toolbar, BorderLayout.NORTH)
            add(scroll, BorderLayout.CENTER)
            add(south, BorderLayout.SOUTH)
            add(statusLabel, BorderLayout.PAGE_END)
        }
    }

    init {
        startClientAndSubscribe()
    }

    fun dispose() {
        scope.cancel()
    }

    // ----- Public hook: chat panel can pre-fill text from the editor action -----
    fun prefillInput(text: String) {
        SwingUtilities.invokeLater {
            val existing = inputArea.text
            inputArea.text = if (existing.isBlank()) text else "$existing\n\n$text"
            inputArea.caretPosition = inputArea.text.length
            inputArea.requestFocusInWindow()
        }
    }

    /** Send an editor-selected snippet as a "Explain this" request. */
    fun sendEditorContext(filePath: String, language: String?, snippet: String) {
        val tagged = buildString {
            append("Here is a snippet from `").append(filePath).append("`")
            language?.let { append(" (").append(it).append(")") }
            append(":\n\n```")
            language?.let { append(it) }
            append("\n").append(snippet).append("\n```\n\nPlease explain what this code does.")
        }
        prefillInput(tagged)
    }

    // ----- Subsystem wire-up -----

    private fun startClientAndSubscribe() {
        scope.launch(Dispatchers.IO) {
            val c = client
            if (c == null) {
                SwingUtilities.invokeLater { statusLabel.text = "Failed to start codepilot process. Check Settings → Tools → CodePilot." }
                return@launch
            }
            // Open a session up front; create lazily on first send if it fails.
            try {
                sessionId = CodepilotService.getInstance(project).newSessionId()
                SwingUtilities.invokeLater { statusLabel.text = "Connected. session=${sessionId?.take(8) ?: "?"}" }
            } catch (t: Throwable) {
                log.warn("Initial session creation failed: ${t.message}", t)
            }
            sendButton.isEnabled = true

            // Subscribe to the per-session event flow (also receives global notifications).
            c.events.collect { msg ->
                when (msg) {
                    is IncomingMessage.ServerRequest -> handleServerRequest(msg)
                    is IncomingMessage.Notification -> handleNotification(msg)
                    is IncomingMessage.Response -> handleServerResponse(msg)
                    is IncomingMessage.Error -> {
                        appendSystem("Server error ${msg.error.get("code")?.asInt}: ${msg.error.get("message")?.asString}")
                    }
                    is IncomingMessage.Failure -> {
                        appendSystem("Connection failure: ${msg.message}")
                        sendButton.isEnabled = false
                        cancelButton.isEnabled = false
                    }
                }
            }
        }
    }

    private fun handleServerRequest(msg: IncomingMessage.ServerRequest) {
        when (msg.method) {
            "permission/request" -> {
                val requestId = msg.params.get("requestId").asString
                val toolName = msg.params.get("toolName").asString
                val reason = msg.params.get("reason")?.asString ?: ""
                val input = msg.params.get("input")?.toString() ?: ""
                val decision = askUserPermission(toolName, reason, input)
                scope.launch(Dispatchers.IO) {
                    client?.respondPermission(requestId, decision)
                }
            }
            else -> {
                appendSystem("Unhandled server request: ${msg.method}")
            }
        }
    }

    private fun handleNotification(msg: IncomingMessage.Notification) {
        when (msg.method) {
            "event" -> onSessionEvent(msg.params)
            "session/usage" -> {
                val usage = msg.params.get("usage")?.toString() ?: "{}"
                SwingUtilities.invokeLater { statusLabel.text = "Usage: $usage" }
            }
            else -> {
                appendSystem("Unhandled server notification: ${msg.method}")
            }
        }
    }

    private fun handleServerResponse(msg: IncomingMessage.Response) {
        // Streamed responses are wrapped in the `event` notification — see docs/PROTOCOL.md.
        // But some servers may also send bare results. Treat generically.
        appendSystem("Response id=${msg.result}")
    }

    /** Permission dialog with Allow / Always / Deny buttons. */
    private fun askUserPermission(toolName: String, reason: String, input: String): String {
        val detail = buildString {
            append("Tool: ").append(toolName).append("\n")
            if (reason.isNotEmpty()) append("Reason: ").append(reason).append("\n")
            if (input.isNotEmpty()) append("Input:\n").append(prettyJson(input).take(1024))
        }
        val options = arrayOf("Allow", "Always", "Deny")
        val choice = JOptionPane.showOptionDialog(
            component,
            detail,
            "CodePilot wants to use $toolName",
            JOptionPane.DEFAULT_OPTION,
            JOptionPane.WARNING_MESSAGE,
            null,
            options,
            options[0],
        )
        return when (choice) {
            0 -> "allow"
            1 -> "always"
            else -> "deny"
        }
    }

    private fun prettyJson(raw: String): String = try {
        com.google.gson.JsonParser.parseString(raw).toString()
    } catch (_: Throwable) {
        raw
    }

    // ----- Send / cancel -----

    private fun sendCurrentInput() {
        val text = inputArea.text.trim()
        if (text.isEmpty()) return
        val c = client
        if (c == null) {
            appendSystem("Not connected.")
            return
        }
        val sid = sessionId
        if (sid == null) {
            // Try to lazily open a session and requeue.
            scope.launch(Dispatchers.IO) {
                val newId = CodepilotService.getInstance(project).newSessionId()
                sessionId = newId
                if (newId != null) {
                    appendUser(text)
                    inputArea.text = ""
                    sendButton.isEnabled = false
                    cancelButton.isEnabled = true
                    c.sendPrompt(newId, text)
                    statusLabel.text = "Streaming…"
                } else {
                    appendSystem("Failed to open session.")
                }
            }
            return
        }
        appendUser(text)
        inputArea.text = ""
        sendButton.isEnabled = false
        cancelButton.isEnabled = true
        c.sendPrompt(sid, text)
        statusLabel.text = "Streaming…"
    }

    private fun cancelCurrent() {
        val sid = sessionId ?: return
        client?.cancelPrompt(sid)
        cancelButton.isEnabled = false
        sendButton.isEnabled = true
        statusLabel.text = "Cancelled."
    }

    private fun startNewSession() {
        scope.launch(Dispatchers.IO) {
            try {
                val newId = CodepilotService.getInstance(project).newSessionId()
                sessionId = newId
                streamingMessages.clear()
                streamingToolInputs.clear()
                SwingUtilities.invokeLater {
                    messagePane.text = ""
                    statusLabel.text = "New session: ${newId?.take(8) ?: "(failed)"}"
                }
            } catch (t: Throwable) {
                appendSystem("Failed to open new session: ${t.message}")
            }
        }
    }

    // ----- Message rendering -----

    private fun appendUser(text: String) {
        appendHtml("<div style='margin:6px 0'><b style='color:#3a6df0'>You:</b><br><pre style='background:${codeBg()};padding:6px;border-radius:4px;white-space:pre-wrap'>${escape(text)}</pre></div>")
    }

    private fun appendSystem(text: String) {
        appendHtml("<div style='margin:4px 0;color:#888;font-style:italic'>[${escape(text)}]</div>")
    }

    private fun appendAssistant(text: String) {
        appendHtml("<div style='margin:6px 0'><b style='color:#2f7d3a'>CodePilot:</b><br>${escape(text).replace("\n", "<br>")}</div>")
    }

    private fun appendToolCall(name: String, input: String) {
        appendHtml(
            "<div style='margin:6px 0'>" +
                "<details><summary><b style='color:#a35b00'>tool_call: ${escape(name)}</b></summary>" +
                "<pre style='background:${codeBg()};padding:6px;border-radius:4px;white-space:pre-wrap'>${escape(prettyJson(input))}</pre>" +
                "</details></div>"
        )
    }

    private fun appendToolResult(name: String, content: String, isError: Boolean) {
        val color = if (isError) "#a00000" else "#555"
        appendHtml("<div style='margin:6px 0'><b style='color:$color'>tool_result: ${escape(name)}</b><br><pre style='background:${codeBg()};padding:6px;border-radius:4px;white-space:pre-wrap'>${escape(content.take(4000))}${if (content.length > 4000) "\n…" else ""}</pre></div>")
    }

    private fun appendPlan(steps: List<PlanStep>) {
        lastPlan = steps
        val sb = StringBuilder("<div style='margin:6px 0'><b style='color:#555'>Plan:</b><ol>")
        for (s in steps) {
            sb.append("<li>[${escape(s.status)}] ${escape(s.title)}")
        }
        sb.append("</ol></div>")
        appendHtml(sb.toString())
    }

    private fun appendUsage(usage: UsageInfo) {
        val txt = "tokens in=${usage.input} out=${usage.output}" +
            (usage.cacheRead?.let { " cacheRead=$it" } ?: "") +
            (usage.cacheWrite?.let { " cacheWrite=$it" } ?: "") +
            (usage.costUSD?.let { " cost=$$it" } ?: "")
        appendSystem(txt)
    }

    private fun appendError(message: String) {
        appendHtml("<div style='margin:6px 0;color:#a00000'><b>Error:</b> ${escape(message)}</div>")
    }

    /** Append streamed delta to the in-progress assistant buffer and re-render. */
    private fun streamAssistantDelta(messageId: String, delta: String) {
        val current = streamingMessages[messageId] ?: ""
        val combined = current + delta
        streamingMessages[messageId] = combined
        // Re-render the assistant message in-place.
        appendAssistant(combined)
    }

    /** Stream a tool_call input by buffering partial JSON until the tool_call message arrives. */
    private fun streamToolInputDelta(toolCallId: String, partialJson: String) {
        streamingToolInputs[toolCallId] = (streamingToolInputs[toolCallId] ?: "") + partialJson
    }

    // ----- HTML helpers -----

    private fun codeBg(): String = if (JBColor.isBright()) "#f0f0f0" else "#2b2b2b"
    private fun appendHtml(html: String) {
        SwingUtilities.invokeLater {
            val doc: HTMLDocument = messagePane.styledDocument as HTMLDocument
            try {
                // Use insertAfterEnd on the body element so we keep existing styling.
                val kit = messagePane.editorKit as HTMLEditorKit
                kit.insertHTML(doc, doc.length, html, 0, 0, null)
                messagePane.caretPosition = doc.length
            } catch (e: BadLocationException) {
                log.warn("appendHtml failed: ${e.message}", e)
            }
        }
    }

    private fun escape(s: String): String = s
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")

    // ----- Event normalization from server `event` notifications -----
    /**
     * The server sends notifications of the form `event { sessionId, event: Event }`.
     * We unwrap here and dispatch on the event `type`.
     */
    fun onSessionEvent(wrapper: JsonObject) {
        val event = wrapper.get("event")?.asJsonObject ?: return
        when (event.get("type")?.asString) {
            "message" -> {
                val role = event.get("role")?.asString ?: "assistant"
                val content = event.getAsJsonArray("content") ?: return
                val text = StringBuilder()
                for (el in content) {
                    val block = el.asJsonObject
                    if (block.get("type")?.asString == "text") {
                        text.append(block.get("text")?.asString ?: "")
                    } else if (block.get("type")?.asString == "tool_use") {
                        val name = block.get("name")?.asString ?: "?"
                        val input = block.get("input")?.toString() ?: "{}"
                        appendToolCall(name, input)
                    }
                }
                if (text.isNotEmpty()) {
                    if (role == "user") appendUser(text.toString()) else appendAssistant(text.toString())
                }
            }
            "message_delta" -> {
                val messageId = event.get("messageId")?.asString ?: return
                val delta = event.getAsJsonObject("delta") ?: return
                when (delta.get("type")?.asString) {
                    "text" -> streamAssistantDelta(messageId, delta.get("text")?.asString ?: "")
                    "tool_input_json" -> {
                        val toolCallId = delta.get("toolCallId")?.asString ?: return
                        streamToolInputDelta(toolCallId, delta.get("partialJson")?.asString ?: "")
                    }
                }
            }
            "tool_call" -> {
                val name = block(event, "name") ?: "?"
                val id = block(event, "id") ?: ""
                val input = block(event, "input") ?: "{}"
                appendToolCall(name, input)
                if (id.isNotEmpty()) streamingToolInputs.remove(id)
            }
            "tool_result" -> {
                val name = block(event, "name") ?: "?"
                val content = block(event, "content") ?: ""
                val isError = block(event, "isError")?.toBoolean() ?: false
                appendToolResult(name, content, isError)
            }
            "plan" -> {
                val arr = event.getAsJsonArray("steps") ?: return
                val steps = arr.map { el ->
                    val o = el.asJsonObject
                    PlanStep(
                        id = o.get("id")?.asString ?: "",
                        title = o.get("title")?.asString ?: "",
                        status = o.get("status")?.asString ?: "pending",
                    )
                }
                appendPlan(steps)
            }
            "usage" -> {
                val usage = event.getAsJsonObject("usage") ?: return
                appendUsage(
                    UsageInfo(
                        input = usage.get("input")?.asLong ?: 0,
                        output = usage.get("output")?.asLong ?: 0,
                        cacheRead = usage.get("cacheRead")?.asLong,
                        cacheWrite = usage.get("cacheWrite")?.asLong,
                        costUSD = usage.get("costUSD")?.asDouble,
                    )
                )
            }
            "compaction" -> appendSystem("Context compacted: ${event.get("summary")?.asString ?: ""}")
            "status" -> {
                val status = event.get("status")?.asString ?: ""
                SwingUtilities.invokeLater { statusLabel.text = "Status: $status" }
            }
            "error" -> appendError(event.get("message")?.asString ?: "unknown error")
        }
    }

    private fun block(o: JsonObject, key: String): String? =
        o.get(key)?.let {
            if (it.isJsonNull) null else if (it.isJsonPrimitive) it.asString else it.toString()
        }
}

data class PlanStep(val id: String, val title: String, val status: String)
data class UsageInfo(
    val input: Long,
    val output: Long,
    val cacheRead: Long? = null,
    val cacheWrite: Long? = null,
    val costUSD: Double? = null,
)