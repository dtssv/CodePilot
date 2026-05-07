package io.codepilot.plugin.toolwindow

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.actions.ClipboardBridge
import io.codepilot.plugin.auth.LoginDialog
import io.codepilot.plugin.conversation.ConversationClient
import io.codepilot.plugin.session.SessionStore
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.tools.PatchApplier
import io.codepilot.plugin.tools.ToolDispatcher
import io.codepilot.plugin.ui.NeedsInputDialog
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.ActionEvent
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import javax.swing.AbstractAction
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.SwingUtilities

/** Swing chat panel wiring the full SSE -> tool-dispatch -> patch-apply loop. */
class CodePilotChatPanel(private val project: Project) {

    private val settings = CodePilotSettings.getInstance()
    private val sessionStore = SessionStore.getInstance()
    private val client = ConversationClient()
    private val transcript = JBTextArea(20, 80)
    private val planView = JBTextArea(10, 40)
    private val ledgerView = JBTextArea(6, 40)
    private val inputArea = JBTextArea(4, 80)
    private val modeBox = JComboBox(arrayOf("agent", "chat"))
    private val modelBox = JComboBox<ModelItem>()
    private val sendButton = JButton("Send")
    private val stopButton = JButton("Stop").apply { isEnabled = false }
    private val signInButton = JButton("Sign in")

    private val sessionHandle = sessionStore.newSession(workspaceHash(), modeBox.selectedItem as String, null)
    private val dispatcher = ToolDispatcher(project, client, sessionHandle.meta.id)
    private val patcher = PatchApplier(project)

    init {
        listOf(transcript, planView, ledgerView).forEach {
            it.isEditable = false
            it.lineWrap = true
            it.wrapStyleWord = true
        }
        sendButton.action = SendAction()
        stopButton.action = StopAction()
        signInButton.addActionListener { LoginDialog(project).showAndGet() }
        inputArea.addFocusListener(object : FocusAdapter() {
            override fun focusGained(e: FocusEvent?) {
                ClipboardBridge.consume()?.let { prefilled ->
                    if (inputArea.text.isBlank()) inputArea.text = prefilled
                }
            }
        })
        // Load models from backend
        fetchModels()
    }

    /** Data class for model dropdown items. */
    private data class ModelItem(val id: String, val name: String, val type: String) {
        override fun toString(): String = if (type == "custom") "$name (custom)" else name
    }

    val component: JComponent =
        JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4)
            add(buildToolbar(), BorderLayout.NORTH)
            add(buildBody(), BorderLayout.CENTER)
            add(buildFooter(), BorderLayout.SOUTH)
        }

    private fun buildToolbar(): JComponent =
        JPanel().apply {
            layout = BoxLayout(this, BoxLayout.LINE_AXIS)
            add(JLabel("Mode:"))
            add(Box.createHorizontalStrut(4))
            add(modeBox)
            add(Box.createHorizontalStrut(8))
            add(JLabel("Model:"))
            add(Box.createHorizontalStrut(4))
            add(modelBox)
            add(Box.createHorizontalGlue())
            add(signInButton)
            add(Box.createHorizontalStrut(4))
            add(stopButton)
        }

    private fun buildBody(): JComponent {
        val sidebar =
            JPanel(BorderLayout()).apply {
                add(JLabel("Plan"), BorderLayout.NORTH)
                add(JBScrollPane(planView), BorderLayout.CENTER)
                add(
                    JPanel(BorderLayout()).apply {
                        add(JLabel("Task Ledger"), BorderLayout.NORTH)
                        add(JBScrollPane(ledgerView), BorderLayout.CENTER)
                    },
                    BorderLayout.SOUTH,
                )
                preferredSize = Dimension(280, preferredSize.height)
            }
        val transcriptPane = JBScrollPane(transcript)
        val split = JSplitPane(JSplitPane.HORIZONTAL_SPLIT, sidebar, transcriptPane)
        split.dividerLocation = 280
        split.resizeWeight = 0.0
        return split
    }

    private fun buildFooter(): JComponent {
        val pane = JBScrollPane(inputArea)
        pane.verticalScrollBarPolicy = JScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
        return JPanel(BorderLayout()).apply {
            border = JBUI.Borders.emptyTop(4)
            add(pane, BorderLayout.CENTER)
            add(sendButton, BorderLayout.EAST)
        }
    }

    private fun appendTranscript(line: String) {
        SwingUtilities.invokeLater {
            transcript.append(line)
            transcript.append("\n")
            transcript.caretPosition = transcript.document.length
        }
    }

    private fun setPlan(text: String) = SwingUtilities.invokeLater { planView.text = text }

    private fun setLedger(text: String) = SwingUtilities.invokeLater { ledgerView.text = text }

    private fun resetButtons() = SwingUtilities.invokeLater {
        sendButton.isEnabled = true
        stopButton.isEnabled = false
    }

    private inner class SendAction : AbstractAction("Send") {
        override fun actionPerformed(e: ActionEvent?) {
            val text = inputArea.text.trim().ifEmpty { return }
            inputArea.text = ""
            appendTranscript("> $text")
            sessionStore.appendMessage(sessionHandle, "user", text)
            sendButton.isEnabled = false
            stopButton.isEnabled = true

            val payload = basePayload(text, intent = "new")
            client.run(payload, panelListener(text))
        }
    }

    private inner class StopAction : AbstractAction("Stop") {
        override fun actionPerformed(e: ActionEvent?) {
            client.stop(sessionHandle.meta.id)
            resetButtons()
        }
    }

    private fun basePayload(input: String, intent: String, extras: Map<String, Any?> = emptyMap()): Map<String, Any?> {
        val mode = modeBox.selectedItem as String
        val selectedModel = modelBox.selectedItem as? ModelItem
        val base = mutableMapOf<String, Any?>(
            "sessionId" to sessionHandle.meta.id,
            "mode" to mode,
            "modelId" to selectedModel?.id,
            "input" to input,
            "intent" to intent,
            "options" to mapOf("locale" to settings.state.preferredLocale),
            "policy" to mapOf(
                "selfCheck" to true,
                "contextBudgetTokens" to settings.state.contextBudgetTokens,
                "keepRecentMessages" to settings.state.keepRecentMessages,
            ),
            "tools" to listOf(
                "fs.read", "fs.list", "fs.search", "fs.outline",
                "fs.create", "fs.write", "fs.replace", "fs.delete", "fs.move",
                "shell.exec", "plan.show",
            ),
        )
        base.putAll(extras)
        base["userSkills"] = collectUserSkills()
        base["projectRootHash"] = projectRootHash()
        return base
    }

    private fun collectUserSkills(): List<Map<String, Any?>> {
        val store = io.codepilot.plugin.marketplace.LocalMarketplaceStore.getInstance()
        return store.activeSkills(project).map { active ->
            mapOf(
                "id" to active.entry.id,
                "version" to active.entry.version,
                "source" to "user",
                "scope" to active.scope,
                "projectRootHash" to projectRootHash(),
                "sha256" to active.entry.sha256,
                "yaml" to store.readSkillBody(active),
            )
        }
    }

    private fun projectRootHash(): String {
        val base = project.basePath ?: project.name
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(base.toByteArray())
        return java.util.HexFormat.of().formatHex(digest)
    }

    private fun panelListener(originalInput: String): ConversationClient.Listener =
        object : ConversationClient.Listener {
            override fun onDelta(text: String) = appendTranscript(text)
            override fun onPlan(payload: JsonNode) {
                setPlan(payload.toPrettyString())
                sessionStore.savePlan(sessionHandle, payload)
            }
            override fun onPlanDelta(payload: JsonNode) {
                appendTranscript("[plan_delta] " + payload.toPrettyString())
            }
            override fun onTaskLedger(payload: JsonNode) {
                setLedger(payload.toPrettyString())
                sessionStore.saveLedger(sessionHandle, payload)
            }
            override fun onSelfCheck(payload: JsonNode) =
                appendTranscript("[self_check] nextAction=" + payload.path("nextAction").asText("?"))
            override fun onToolCall(payload: JsonNode) {
                appendTranscript("[tool_call] " + payload.path("name").asText())
                dispatcher.dispatch(payload)
            }
            override fun onRiskNotice(payload: JsonNode) =
                appendTranscript("[risk_notice] " + payload.path("headline").asText(""))
            override fun onNeedsInput(payload: JsonNode) {
                ApplicationManager.getApplication().invokeLater {
                    val dialog = NeedsInputDialog(project, payload)
                    if (dialog.showAndGet()) {
                        val answers = dialog.answers()
                        if (answers.isNotEmpty()) {
                            val next = basePayload(originalInput, "answer", mapOf("answers" to answers))
                            client.run(next, panelListener(originalInput))
                        }
                    }
                }
            }
            override fun onPatch(payload: JsonNode) {
                appendTranscript("[patch] preparing diff preview…")
                patcher.applyAll(payload)
            }
            override fun onError(code: Int, message: String) =
                appendTranscript("[error $code] $message")
            override fun onDone(reason: String, payload: JsonNode) {
                appendTranscript("[done] $reason")
                resetButtons()
            }
            override fun onClosed() = resetButtons()
        }

    /** Fetches model list from backend and populates the model dropdown. */
    private fun fetchModels() {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val http = io.codepilot.plugin.transport.HttpClientService.getInstance()
                val url = (settings.state.backendBaseUrl.trimEnd('/') + "/v1/models")
                val request = okhttp3.Request.Builder()
                    .url(url)
                    .get()
                    .header("Accept", "application/json")
                    .build()
                val response = http.client().newCall(request).execute()
                response.use { resp ->
                    if (resp.isSuccessful) {
                        val body = resp.body?.string() ?: return@use
                        val node = com.fasterxml.jackson.databind.ObjectMapper().readTree(body)
                        val data = node.path("data")
                        val items = mutableListOf<ModelItem>()
                        // Parse system models
                        data.path("system").forEach { m ->
                            items.add(ModelItem(
                                id = m.path("id").asText(),
                                name = m.path("name").asText(),
                                type = "system"
                            ))
                        }
                        // Parse custom models
                        data.path("custom").forEach { m ->
                            items.add(ModelItem(
                                id = m.path("id").asText(),
                                name = m.path("name").asText(),
                                type = "custom"
                            ))
                        }
                        SwingUtilities.invokeLater {
                            modelBox.removeAllItems()
                            items.forEach { modelBox.addItem(it) }
                        }
                    }
                }
            } catch (e: Exception) {
                // Silently ignore — models will be empty, user can still type
            }
        }
    }

    private fun workspaceHash(): String =
        ApplicationManager.getApplication()
            .runReadAction<String> { (project.basePath ?: project.name).hashCode().toString(16) }
}