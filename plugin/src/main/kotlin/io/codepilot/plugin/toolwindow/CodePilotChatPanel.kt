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

import io.codepilot.plugin.hooks.HookEngine

import io.codepilot.plugin.marketplace.SkillRefCollector

import io.codepilot.plugin.settings.CodePilotSettings

import io.codepilot.plugin.context.InlineContextExpander

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

import java.util.concurrent.ConcurrentHashMap



/** Swing chat panel wiring the full SSE -> tool-dispatch -> patch-apply loop. */

class CodePilotChatPanel(

    private val project: Project,

) : QuickActionChatSink {

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



    private var sessionHandle = sessionStore.newSession(workspaceHash(), modeBox.selectedItem as String, null)

    private var dispatcher = ToolDispatcher(project, client, sessionHandle.meta.id)

    private val patcher = PatchApplier(project)

    private val quickContextStore = ConcurrentHashMap<String, String>()



    init {

        listOf(transcript, planView, ledgerView).forEach {

            it.isEditable = false

            it.lineWrap = true

            it.wrapStyleWord = true

        }

        sendButton.action = SendAction()

        stopButton.action = StopAction()

        signInButton.addActionListener { LoginDialog(project).showAndGet() }

        inputArea.addFocusListener(

            object : FocusAdapter() {

                override fun focusGained(e: FocusEvent?) {

                    ClipboardBridge.consume()?.let { prefilled ->

                        if (inputArea.text.isBlank()) inputArea.text = prefilled

                    }

                }

            },

        )

        // Load models from backend

        fetchModels()

    }



    private val inlineCtxCleanup = Regex("\u0001[^\u0001]*\u0001")



    override fun storeContext(

        id: String,

        fullCode: String,

    ) {

        quickContextStore[id] = fullCode

    }



    override fun submitQuickUserMessage(

        textWithInlineContextMarkers: String,

        contextRefs: List<Map<String, Any?>>,

        mode: String,

    ) {

        val fullText =

            InlineContextExpander.expand(textWithInlineContextMarkers, quickContextStore, contextRefs)

        SwingUtilities.invokeLater {

            try {

                modeBox.selectedItem = mode

            } catch (_: Exception) {

            }

            val cleaned =

                textWithInlineContextMarkers.replace(inlineCtxCleanup, "").trim()

            appendTranscript("> $cleaned")



            val userMsgExtra = mutableMapOf<String, Any?>()

            if (contextRefs.isNotEmpty()) userMsgExtra["contextRefs"] = contextRefs

            sessionStore.appendMessage(sessionHandle, "user", textWithInlineContextMarkers, userMsgExtra.toMap())



            sendButton.isEnabled = false

            stopButton.isEnabled = true



            val payload = basePayload(fullText, intent = "new")

            runConversationAfterHook(payload, panelListener(fullText))

        }

    }



    override fun dispatchContextAdded(meta: Map<String, Any?>) {

        val display = meta["display"]?.toString() ?: meta["id"]?.toString() ?: "context"

        appendTranscript("[Context attached] $display")

    }



    override fun prepareFreshChatSession() {

        fun run() {

            quickContextStore.clear()

            inputArea.text = ""

            val mode = modeBox.selectedItem as String

            sessionHandle = sessionStore.newSession(workspaceHash(), mode, null)

            dispatcher = ToolDispatcher(project, client, sessionHandle.meta.id)

            appendTranscript("\n--- New chat ---\n")

        }

        if (SwingUtilities.isEventDispatchThread()) {

            run()

        } else {

            SwingUtilities.invokeLater { run() }

        }

    }



    /** Data class for model dropdown items. */

    private data class ModelItem(

        val id: String,

        val name: String,

        val type: String,

    ) {

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



    private fun resetButtons() =

        SwingUtilities.invokeLater {

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

            runConversationAfterHook(payload, panelListener(text))

        }

    }



    private inner class StopAction : AbstractAction("Stop") {

        override fun actionPerformed(e: ActionEvent?) {

            client.stop(sessionHandle.meta.id)

            resetButtons()

        }

    }



    private fun basePayload(

        input: String,

        intent: String,

        extras: Map<String, Any?> = emptyMap(),

    ): Map<String, Any?> {

        val mode = modeBox.selectedItem as String

        val selectedModel = modelBox.selectedItem as? ModelItem

        val base =

            mutableMapOf<String, Any?>(

                "sessionId" to sessionHandle.meta.id,

                "mode" to mode,

                "modelId" to selectedModel?.id,

                "modelSource" to when (selectedModel?.type) {

                    "custom" -> "custom"

                    else -> if (selectedModel != null) "group" else null

                },

                "input" to input,

                "intent" to intent,

                "options" to mapOf("locale" to settings.state.preferredLocale),

                "policy" to

                    mapOf(

                        "selfCheck" to true,

                        "contextBudgetTokens" to settings.state.contextBudgetTokens,

                        "keepRecentMessages" to settings.state.keepRecentMessages,

                    ),

                "tools" to

                    listOf(

                        "fs.read",

                        "fs.list",

                        "fs.search",

                        "fs.outline",

                        "fs.create",

                        "fs.write",

                        "fs.replace",

                        "fs.delete",

                        "fs.move",

                        "shell.exec",

                        "plan.show",

                    ),

            )

        base.putAll(extras)

        val rootHash = SkillRefCollector.projectRootHash(project)

        base["projectRootHash"] = rootHash

        // Chat mode: SkillRouter uses full userSkills (yaml). Agent + graph: only userSkillRefs /

        // userSkillBodies are seeded into graph state (see IntakeAction); sending only userSkills

        // would activate nothing in the default graph engine.

        if (mode == "chat") {

            base["userSkills"] = collectUserSkills()

        } else {

            val skillPayload = SkillRefCollector.collect(project, rootHash)

            if (skillPayload.refs.isNotEmpty()) {

                base["userSkillRefs"] = skillPayload.refs

            }

            if (skillPayload.bodies.isNotEmpty()) {

                base["userSkillBodies"] = skillPayload.bodies

            }

        }

        try {

            val mcpTools = dispatcher.initMcpServers()

            if (mcpTools.isNotEmpty()) {

                base["mcpTools"] = mcpTools

            }

        } catch (_: Exception) {

            /* same as CefChatPanel: MCP metadata is best-effort */

        }

        return base

    }



    /**

     * Runs [HookEngine] **beforeSubmitPrompt** then starts the SSE stream.

     * Keeps behavior aligned with [CefChatPanel] so hooks configured in Integrations apply

     * to the Swing fallback chat as well.

     */

    private fun runConversationAfterHook(

        payload: Map<String, Any?>,

        listener: ConversationClient.Listener,

    ) {

        val mode = payload["mode"] as? String ?: "agent"

        val msg = (payload["input"] as? String)?.take(500) ?: ""

        val hookResult =

            HookEngine.getInstance(project).run(

                "beforeSubmitPrompt",

                mapOf("sessionId" to sessionHandle.meta.id, "mode" to mode, "message" to msg),

            )

        if (!hookResult.pass) {

            appendTranscript("[hook blocked] ${hookResult.reason}")

            resetButtons()

            return

        }

        client.run(payload, listener)

    }



    private fun collectUserSkills(): List<Map<String, Any?>> {

        val store =

            io.codepilot.plugin.marketplace.LocalMarketplaceStore

                .getInstance()

        return store.activeSkills(project).map { active ->

            mapOf(

                "id" to active.entry.id,

                "version" to active.entry.version,

                "source" to "user",

                "scope" to active.scope,

                "projectRootHash" to SkillRefCollector.projectRootHash(project),

                "sha256" to active.entry.sha256,

                "yaml" to store.readSkillBody(active),

            )

        }

    }



    private fun panelListener(originalInput: String): ConversationClient.Listener =

        object : ConversationClient.Listener {

            override fun onDelta(text: String) = appendTranscript(text)









            override fun onSelfCheck(payload: JsonNode) =

                appendTranscript("[self_check] nextAction=" + payload.path("nextAction").asText("?"))



            override fun onToolCall(payload: JsonNode) {

                appendTranscript("[tool_call] " + payload.path("name").asText())

                dispatcher.dispatch(payload)

            }







            override fun onError(

                code: Int,

                message: String,

            ) = appendTranscript("[error $code] $message")



            override fun onDone(

                reason: String,

                payload: JsonNode,

            ) {

                appendTranscript("[done] $reason")

                resetButtons()

            }



            override fun onClosed() = resetButtons()

        }



    /** Fetches model list from backend and populates the model dropdown. */

    private fun fetchModels() {

        ApplicationManager.getApplication().executeOnPooledThread {

            try {

                doFetchModels()

            } catch (_: Exception) {

                // Silently ignore — models will be empty, user can still type

            }

        }

    }



    private fun doFetchModels(retries: Int = 1) {

        val http =

            io.codepilot.plugin.transport.HttpClientService

                .getInstance()

        val url = (settings.state.backendBaseUrl.trimEnd('/') + "/v1/models")

        val request =

            okhttp3.Request

                .Builder()

                .url(url)

                .get()

                .header("Accept", "application/json")

                .build()

        val response = http.client().newCall(request).execute()

        response.use { resp ->

            if (resp.isSuccessful) {

                val body = resp.body?.string() ?: return

                val node =

                    com.fasterxml.jackson.databind

                        .ObjectMapper()

                        .readTree(body)

                val data = node.path("data")

                val items = mutableListOf<ModelItem>()

                // Parse system models

                data.path("system").forEach { m ->

                    items.add(

                        ModelItem(

                            id = m.path("id").asText(),

                            name = m.path("name").asText(),

                            type = "system",

                        ),

                    )

                }

                // Parse custom models

                data.path("custom").forEach { m ->

                    items.add(

                        ModelItem(

                            id = m.path("id").asText(),

                            name = m.path("name").asText(),

                            type = "custom",

                        ),

                    )

                }

                SwingUtilities.invokeLater {

                    modelBox.removeAllItems()

                    items.forEach { modelBox.addItem(it) }

                }

            } else if (resp.code == 401 && retries > 0) {

                // Prompt login on 401, then retry once

                SwingUtilities.invokeLater {

                    val loggedIn = LoginDialog(project).showAndGet()

                    if (loggedIn) {

                        ApplicationManager.getApplication().executeOnPooledThread {

                            try {

                                doFetchModels(retries - 1)

                            } catch (_: Exception) {

                            }

                        }

                    }

                }

            }

        }

    }



    private fun workspaceHash(): String =

        ApplicationManager

            .getApplication()

            .runReadAction<String> { (project.basePath ?: project.name).hashCode().toString(16) }

}

