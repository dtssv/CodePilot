package io.codepilot.plugin.toolwindow

import com.fasterxml.jackson.databind.JsonNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.conversation.ConversationClient
import io.codepilot.plugin.session.SessionStore
import io.codepilot.plugin.settings.CodePilotSettings
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.event.ActionEvent
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

/**
 * Minimal but production-grade chat panel. UI is intentionally Swing-only in M5; a JCEF + React
 * front-end can be plugged in later without touching the conversation client.
 */
class CodePilotChatPanel(private val project: Project) {

    private val settings = CodePilotSettings.getInstance()
    private val sessionStore = SessionStore.getInstance()
    private val client = ConversationClient()
    private val transcript = JBTextArea(20, 80)
    private val planView = JBTextArea(10, 40)
    private val ledgerView = JBTextArea(6, 40)
    private val inputArea = JBTextArea(4, 80)
    private val modeBox = JComboBox(arrayOf("agent", "chat"))
    private val sendButton = JButton("Send")
    private val stopButton = JButton("Stop").apply { isEnabled = false }
    private val sessionHandle = sessionStore.newSession(workspaceHash(), modeBox.selectedItem as String, null)

    init {
        listOf(transcript, planView, ledgerView).forEach {
            it.isEditable = false
            it.lineWrap = true
            it.wrapStyleWord = true
        }
        sendButton.action = SendAction()
        stopButton.action = StopAction()
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
            add(Box.createHorizontalGlue())
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

    private inner class SendAction : AbstractAction("Send") {
        override fun actionPerformed(e: ActionEvent?) {
            val text = inputArea.text.trim().ifEmpty { return }
            inputArea.text = ""
            appendTranscript("> $text")
            sessionStore.appendMessage(sessionHandle, "user", text)
            sendButton.isEnabled = false
            stopButton.isEnabled = true

            val payload = mutableMapOf<String, Any?>(
                "sessionId" to sessionHandle.meta.id,
                "mode" to modeBox.selectedItem,
                "input" to text,
                "intent" to "new",
                "options" to mapOf("locale" to settings.state.preferredLocale),
                "policy" to mapOf(
                    "selfCheck" to true,
                    "contextBudgetTokens" to settings.state.contextBudgetTokens,
                    "keepRecentMessages" to settings.state.keepRecentMessages,
                ),
            )

            client.run(payload, object : ConversationClient.Listener {
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
                    appendTranscript("[self_check] " + payload.path("nextAction").asText("?"))
                override fun onNeedsInput(payload: JsonNode) =
                    appendTranscript("[needs_input] " + payload.path("title").asText(""))
                override fun onToolCall(payload: JsonNode) =
                    appendTranscript("[tool_call] " + payload.path("name").asText(""))
                override fun onError(code: Int, message: String) =
                    appendTranscript("[error $code] $message")
                override fun onDone(reason: String, payload: JsonNode) {
                    appendTranscript("[done] $reason")
                    SwingUtilities.invokeLater {
                        sendButton.isEnabled = true
                        stopButton.isEnabled = false
                    }
                }
                override fun onClosed() {
                    SwingUtilities.invokeLater {
                        sendButton.isEnabled = true
                        stopButton.isEnabled = false
                    }
                }
            })
        }
    }

    private inner class StopAction : AbstractAction("Stop") {
        override fun actionPerformed(e: ActionEvent?) {
            client.stop(sessionHandle.meta.id)
            stopButton.isEnabled = false
            sendButton.isEnabled = true
        }
    }

    private fun workspaceHash(): String =
        ApplicationManager.getApplication()
            .runReadAction<String> { (project.basePath ?: project.name).hashCode().toString(16) }
}