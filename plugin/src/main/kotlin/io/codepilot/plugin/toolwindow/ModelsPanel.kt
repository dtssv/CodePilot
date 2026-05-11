package io.codepilot.plugin.toolwindow

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.auth.LoginDialog
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.transport.HttpClientService
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JPasswordField
import javax.swing.ListCellRenderer
import javax.swing.SwingUtilities

/**
 * Models management panel. Shows:
 * - System models (read-only, configured by admin)
 * - User's custom models (CRUD, per-user)
 */
class ModelsPanel(
    private val project: Project,
) {
    private val mapper = jacksonObjectMapper()
    private val settings = CodePilotSettings.getInstance()
    private val http = HttpClientService.getInstance()
    private val log =
        com.intellij.openapi.diagnostic
            .logger<ModelsPanel>()

    private val systemModel = DefaultListModel<ModelItem>()
    private val systemList =
        JBList(systemModel).apply {
            cellRenderer = ModelRenderer()
            emptyText.text = "Loading system models..."
        }

    private val customModel = DefaultListModel<ModelItem>()
    private val customList =
        JBList(customModel).apply {
            cellRenderer = ModelRenderer()
            emptyText.text = "No custom models. Click 'Add' to create one."
        }

    private val status = JLabel(" ")

    init {
        fetchModels()
    }

    val component: JComponent =
        JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4)
            val tabs = JBTabbedPane()
            tabs.addTab("System Models", buildSystemPane())
            tabs.addTab("My Models", buildCustomPane())
            add(tabs, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }

    private fun buildSystemPane(): JComponent {
        val north =
            JPanel(FlowLayout(FlowLayout.LEFT, 4, 4)).apply {
                add(JButton("Refresh").apply { addActionListener { fetchModels() } })
                add(JLabel("  (Configured by administrator, read-only)"))
            }
        return JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(systemList), BorderLayout.CENTER)
        }
    }

    private fun buildCustomPane(): JComponent {
        val north =
            JPanel(FlowLayout(FlowLayout.LEFT, 4, 4)).apply {
                add(JButton("Refresh").apply { addActionListener { fetchModels() } })
                add(JButton("Add Model").apply { addActionListener { addModel() } })
                add(JButton("Edit").apply { addActionListener { editModel() } })
                add(JButton("Delete").apply { addActionListener { deleteModel() } })
                add(JButton("Test Connection").apply { addActionListener { testModel() } })
            }
        return JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(customList), BorderLayout.CENTER)
        }
    }

    private fun fetchModels() {
        status.text = "Loading models..."
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                doFetchModels()
            } catch (e: Exception) {
                SwingUtilities.invokeLater { status.text = "Error: ${e.message}" }
            }
        }
    }

    private fun doFetchModels(retries: Int = 1) {
        val url = settings.state.backendBaseUrl.trimEnd('/') + "/v1/models"
        log.info(
            "[ModelsPanel] Fetching models from: $url, devToken=${settings.state.devToken
                .takeIf { it.isNotBlank() }
                ?.take(8) ?: "null"}",
        )
        val request =
            okhttp3.Request
                .Builder()
                .url(url)
                .get()
                .header("Accept", "application/json")
                .build()
        val response = http.client().newCall(request).execute()
        response.use { resp ->
            log.info("[ModelsPanel] Response: code=${resp.code}, message=${resp.message}")
            if (resp.isSuccessful) {
                val body = resp.body?.string() ?: return
                val node = mapper.readTree(body)
                val data = node.path("data")
                val sysItems = mutableListOf<ModelItem>()
                data.path("system").forEach { m ->
                    sysItems.add(
                        ModelItem(
                            id = m.path("id").asText(),
                            name = m.path("name").asText(),
                            protocol = m.path("protocol").asText("openai"),
                            baseUrl = m.path("baseUrl").asText(""),
                            model = m.path("model").asText(""),
                            type = "system",
                        ),
                    )
                }
                val custItems = mutableListOf<ModelItem>()
                data.path("custom").forEach { m ->
                    custItems.add(
                        ModelItem(
                            id = m.path("id").asText(),
                            name = m.path("name").asText(),
                            protocol = m.path("protocol").asText("openai"),
                            baseUrl = m.path("baseUrl").asText(""),
                            model = m.path("model").asText(""),
                            type = "custom",
                        ),
                    )
                }
                SwingUtilities.invokeLater {
                    systemModel.clear()
                    sysItems.forEach { systemModel.addElement(it) }
                    customModel.clear()
                    custItems.forEach { customModel.addElement(it) }
                    status.text = "${sysItems.size} system + ${custItems.size} custom models."
                }
            } else if (resp.code == 401 && retries > 0) {
                // Prompt login on 401, then retry once
                SwingUtilities.invokeLater {
                    status.text = "Authentication required. Please sign in."
                    val loggedIn = LoginDialog(project).showAndGet()
                    if (loggedIn) {
                        status.text = "Retrying after login..."
                        ApplicationManager.getApplication().executeOnPooledThread {
                            try {
                                doFetchModels(retries - 1)
                            } catch (e: Exception) {
                                SwingUtilities.invokeLater { status.text = "Error: ${e.message}" }
                            }
                        }
                    }
                }
            } else {
                val hint = if (resp.code == 401) " (authentication required — please sign in)" else ""
                SwingUtilities.invokeLater { status.text = "Failed to load models (HTTP ${resp.code})$hint" }
            }
        }
    }

    private fun addModel() {
        val dialog = ModelEditDialog(null)
        if (dialog.showAndGet()) {
            val entry = dialog.getValues()
            createModelOnBackend(entry)
        }
    }

    private fun editModel() {
        val item = customList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a model to edit.", "CodePilot")
            return
        }
        val dialog = ModelEditDialog(item)
        if (dialog.showAndGet()) {
            val entry = dialog.getValues()
            updateModelOnBackend(item.id, entry)
        }
    }

    private fun deleteModel() {
        val item = customList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a model to delete.", "CodePilot")
            return
        }
        if (Messages.showOkCancelDialog(
                project,
                "Delete model '${item.name}'?",
                "CodePilot",
                "Delete",
                "Cancel",
                Messages.getWarningIcon(),
            ) != Messages.OK
        ) {
            return
        }
        deleteModelOnBackend(item.id)
    }

    private fun testModel() {
        val item = customList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a model to test.", "CodePilot")
            return
        }
        status.text = "Testing ${item.name}..."
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val payload =
                    mapOf(
                        "protocol" to item.protocol,
                        "baseUrl" to item.baseUrl,
                        "apiKey" to "***",
                        "model" to item.model,
                    )
                val request = http.postJson("/v1/models/test", payload)
                val resp = http.client().newCall(request).execute()
                resp.use {
                    SwingUtilities.invokeLater {
                        status.text = if (it.isSuccessful) "Connection OK for ${item.name}" else "Test failed (HTTP ${it.code})"
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { status.text = "Test error: ${e.message}" }
            }
        }
    }

    private fun createModelOnBackend(entry: ModelFormData) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val payload =
                    mapOf(
                        "name" to entry.name,
                        "protocol" to entry.protocol,
                        "baseUrl" to entry.baseUrl,
                        "apiKey" to entry.apiKey,
                        "model" to entry.model,
                        "timeoutMs" to entry.timeoutMs,
                    )
                val request = http.postJson("/v1/models", payload)
                val resp = http.client().newCall(request).execute()
                resp.use {
                    SwingUtilities.invokeLater {
                        if (it.isSuccessful) {
                            status.text = "Created ${entry.name}."
                            fetchModels()
                        } else {
                            status.text = "Create failed (HTTP ${it.code})"
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { status.text = "Error: ${e.message}" }
            }
        }
    }

    private fun updateModelOnBackend(
        id: String,
        entry: ModelFormData,
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val payload =
                    mutableMapOf<String, Any?>(
                        "name" to entry.name,
                        "protocol" to entry.protocol,
                        "baseUrl" to entry.baseUrl,
                        "model" to entry.model,
                        "timeoutMs" to entry.timeoutMs,
                    )
                if (entry.apiKey.isNotBlank()) payload["apiKey"] = entry.apiKey
                val url = settings.state.backendBaseUrl.trimEnd('/') + "/v1/models/$id"
                val body = mapper.writeValueAsBytes(payload)
                val request =
                    okhttp3.Request
                        .Builder()
                        .url(url)
                        .put(body.toRequestBody("application/json".toMediaType()))
                        .header("Accept", "application/json")
                        .build()
                val resp = http.client().newCall(request).execute()
                resp.use {
                    SwingUtilities.invokeLater {
                        if (it.isSuccessful) {
                            status.text = "Updated ${entry.name}."
                            fetchModels()
                        } else {
                            status.text = "Update failed (HTTP ${it.code})"
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { status.text = "Error: ${e.message}" }
            }
        }
    }

    private fun deleteModelOnBackend(id: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val url = settings.state.backendBaseUrl.trimEnd('/') + "/v1/models/$id"
                val request =
                    okhttp3.Request
                        .Builder()
                        .url(url)
                        .delete()
                        .header("Accept", "application/json")
                        .build()
                val resp = http.client().newCall(request).execute()
                resp.use {
                    SwingUtilities.invokeLater {
                        if (it.isSuccessful) {
                            status.text = "Deleted."
                            fetchModels()
                        } else {
                            status.text = "Delete failed (HTTP ${it.code})"
                        }
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater { status.text = "Error: ${e.message}" }
            }
        }
    }

    // ---- Data classes ----

    data class ModelItem(
        val id: String,
        val name: String,
        val protocol: String,
        val baseUrl: String,
        val model: String,
        val type: String,
    )

    data class ModelFormData(
        val name: String,
        val protocol: String,
        val baseUrl: String,
        val apiKey: String,
        val model: String,
        val timeoutMs: Int,
    )

    // ---- Renderer ----

    private class ModelRenderer : ListCellRenderer<ModelItem> {
        override fun getListCellRendererComponent(
            list: JList<out ModelItem>,
            value: ModelItem,
            index: Int,
            isSelected: Boolean,
            cellHasFocus: Boolean,
        ): Component {
            val panel =
                JPanel().apply {
                    layout = BoxLayout(this, BoxLayout.Y_AXIS)
                    isOpaque = true
                    background = if (isSelected) list.selectionBackground else list.background
                    border =
                        BorderFactory.createCompoundBorder(
                            BorderFactory.createMatteBorder(0, 0, 1, 0, JBUI.CurrentTheme.CustomFrameDecorations.separatorForeground()),
                            JBUI.Borders.empty(4, 8),
                        )
                }
            val title = JLabel("<html><b>${value.name}</b> &nbsp;<font color='gray'>[${value.protocol}]</font></html>")
            val detail = JLabel("<html>Model: <code>${value.model}</code> &nbsp; Base: <code>${value.baseUrl.take(50)}</code></html>")
            detail.foreground = java.awt.Color.GRAY
            panel.add(title)
            panel.add(detail)
            return panel
        }
    }

    // ---- Edit Dialog ----

    private class ModelEditDialog(
        private val existing: ModelItem?,
    ) : DialogWrapper(true) {
        private val nameField = JBTextField(existing?.name ?: "")
        private val protocolBox =
            JComboBox(arrayOf("openai", "azure-openai", "ollama", "anthropic")).apply {
                selectedItem = existing?.protocol ?: "openai"
            }
        private val baseUrlField = JBTextField(existing?.baseUrl ?: "https://api.openai.com/v1")
        private val apiKeyField = JPasswordField().apply { columns = 30 }
        private val modelField = JBTextField(existing?.model ?: "gpt-4o-mini")
        private val timeoutField = JBTextField("60000")

        init {
            title = if (existing == null) "Add Custom Model" else "Edit Model"
            init()
        }

        override fun createCenterPanel(): JComponent {
            val panel = JPanel(GridBagLayout())
            var row = 0

            fun addRow(
                label: String,
                comp: JComponent,
            ) {
                val gL =
                    GridBagConstraints().apply {
                        gridx = 0
                        gridy = row
                        anchor = GridBagConstraints.WEST
                        insets = Insets(4, 4, 4, 4)
                    }
                val gR =
                    GridBagConstraints().apply {
                        gridx = 1
                        gridy = row
                        weightx = 1.0
                        fill = GridBagConstraints.HORIZONTAL
                        insets =
                            Insets(4, 4, 4, 4)
                    }
                panel.add(JLabel(label), gL)
                panel.add(comp, gR)
                row++
            }
            addRow("Name:", nameField)
            addRow("Protocol:", protocolBox)
            addRow("Base URL:", baseUrlField)
            addRow("API Key:", apiKeyField)
            addRow("Model:", modelField)
            addRow("Timeout (ms):", timeoutField)

            if (existing != null) {
                apiKeyField.echoChar = '*'
                apiKeyField.toolTipText = "Leave blank to keep existing key"
            }

            panel.preferredSize = Dimension(500, 250)
            return panel
        }

        fun getValues() =
            ModelFormData(
                name = nameField.text.trim(),
                protocol = protocolBox.selectedItem as String,
                baseUrl = baseUrlField.text.trim(),
                apiKey = String(apiKeyField.password).trim(),
                model = modelField.text.trim(),
                timeoutMs = timeoutField.text.trim().toIntOrNull() ?: 60000,
            )
    }
}
