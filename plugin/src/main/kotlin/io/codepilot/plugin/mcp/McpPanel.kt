package io.codepilot.plugin.mcp

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.marketplace.LocalMarketplaceStore
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.BorderFactory
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.SwingUtilities

/**
 * MCP Server management panel.
 *
 * - **Install**: Paste JSON config from an MCP Server's documentation page
 *   (typically npx / uvx commands). Supports both single-server and multi-server formats.
 * - **Installed**: View running / installed MCP servers; start, stop, or uninstall.
 */
class McpPanel(
    private val project: Project,
) {
    private val store = LocalMarketplaceStore.getInstance()
    private val mcpManager = McpProcessManager.getInstance()
    // ★ Integration: McpSubscriptionManager for resource subscriptions
    private val subscriptionManager = McpSubscriptionManager.getInstance(project)
    private val mapper = jacksonObjectMapper()

    // ---- Install tab ----
    private val jsonInput =
        JBTextArea(14, 60).apply {
            lineWrap = true
            wrapStyleWord = true
            emptyText.setText("Paste MCP Server JSON config here...")
        }
    private val nameField =
        JBTextField(30).apply {
            emptyText.setText("Server name (e.g. my-mcp-server)")
        }

    // ---- Installed tab ----
    private val installedModel = DefaultListModel<McpServerItem>()
    private val installedList =
        JBList(installedModel).apply {
            cellRenderer = McpServerRenderer()
            emptyText.text = "No MCP servers installed. Paste a JSON config to add one."
        }

    private val status = JLabel(" ")

    init {
        refreshInstalled()
        // Pre-fill example JSON
        jsonInput.text = EXAMPLE_JSON
    }

    val component: JComponent =
        JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4)
            val tabs = JBTabbedPane()
            tabs.addTab("Install MCP Server", buildInstallPane())
            tabs.addTab("Installed", buildInstalledPane())
            add(tabs, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }

    private fun buildInstallPane(): JComponent {
        val form =
            JPanel(GridBagLayout()).apply {
                border = JBUI.Borders.empty(8)

                // Hint label
                val hintGbc =
                    GridBagConstraints().apply {
                        gridx = 0
                        gridy = 0
                        gridwidth = 2
                        weightx = 1.0
                        fill = GridBagConstraints.HORIZONTAL
                        insets = Insets(0, 4, 8, 4)
                    }
                add(
                    JLabel(
                        "<html><b>Paste MCP Server JSON config</b><br>" +
                            "Copy the JSON from the MCP Server's docs page. Supports npx, uvx, node, python commands.<br>" +
                            "Format: <code>{\"mcpServers\":{\"name\":{\"command\":\"npx\",\"args\":[...],\"env\":{...}}}}</code></html>",
                    ),
                    hintGbc,
                )

                // Name field
                val nameLabelGbc =
                    GridBagConstraints().apply {
                        gridx = 0
                        gridy = 1
                        anchor = GridBagConstraints.WEST
                        insets = Insets(4, 4, 4, 4)
                    }
                add(JLabel("Server Name:"), nameLabelGbc)
                val nameFieldGbc =
                    GridBagConstraints().apply {
                        gridx = 1
                        gridy = 1
                        weightx = 1.0
                        fill = GridBagConstraints.HORIZONTAL
                        insets = Insets(4, 4, 4, 4)
                    }
                add(nameField, nameFieldGbc)

                // JSON label
                val jsonLabelGbc =
                    GridBagConstraints().apply {
                        gridx = 0
                        gridy = 2
                        anchor = GridBagConstraints.NORTHWEST
                        insets = Insets(4, 4, 4, 4)
                    }
                add(JLabel("JSON Config:"), jsonLabelGbc)

                // JSON text area
                val jsonGbc =
                    GridBagConstraints().apply {
                        gridx = 1
                        gridy = 2
                        weightx = 1.0
                        weighty = 1.0
                        fill = GridBagConstraints.BOTH
                        insets = Insets(4, 4, 4, 4)
                    }
                add(JBScrollPane(jsonInput), jsonGbc)

                // Buttons
                val btnPanel = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0))
                btnPanel.add(JButton("Install").apply { addActionListener { installFromJson() } })
                btnPanel.add(
                    JButton("Clear").apply {
                        addActionListener {
                            jsonInput.text = EXAMPLE_JSON
                            nameField.text = ""
                        }
                    },
                )
                val btnGbc =
                    GridBagConstraints().apply {
                        gridx = 1
                        gridy = 3
                        weightx = 1.0
                        fill = GridBagConstraints.HORIZONTAL
                        insets = Insets(8, 4, 4, 4)
                    }
                add(btnPanel, btnGbc)
            }
        return form
    }

    private fun buildInstalledPane(): JComponent {
        val north =
            JPanel(FlowLayout(FlowLayout.LEFT, 4, 4)).apply {
                add(JButton("Refresh").apply { addActionListener { refreshInstalled() } })
                add(JButton("Start").apply { addActionListener { startSelected() } })
                add(JButton("Stop").apply { addActionListener { stopSelected() } })
                add(JButton("Uninstall").apply { addActionListener { uninstallSelected() } })
            }
        return JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(installedList), BorderLayout.CENTER)
        }
    }

    private fun installFromJson() {
        val raw = jsonInput.text.trim()
        if (raw.isBlank()) {
            Messages.showWarningDialog(project, "Please paste a JSON configuration.", "CodePilot")
            return
        }
        try {
            val entries = parseJsonConfig(raw)
            if (entries.isEmpty()) {
                Messages.showErrorDialog(
                    project,
                    "Could not parse any MCP server from the JSON.\nExpected format: {\"mcpServers\":{\"name\":{\"command\":\"...\",\"args\":[...]}}}",
                    "CodePilot",
                )
                return
            }
            var installed = 0
            for (entry in entries) {
                store.installMcp(entry)
                installed++
            }
            status.text = "Installed $installed MCP server(s)."
            refreshInstalled()
            Messages.showInfoMessage(project, "Installed $installed MCP server(s): ${entries.joinToString { it.id }}", "CodePilot")
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to parse JSON: ${e.message}", "CodePilot")
        }
    }

    /**
     * Parses MCP JSON config. Supports two formats:
     * 1. Standard: {"mcpServers":{"name":{"command":"npx","args":[...],"env":{...}}}}
     * 2. Single:   {"command":"npx","args":[...],"env":{...}}
     */
    private fun parseJsonConfig(raw: String): List<LocalMarketplaceStore.McpEntry> {
        val node = mapper.readTree(raw)
        val results = mutableListOf<LocalMarketplaceStore.McpEntry>()

        if (node.has("mcpServers")) {
            val servers = node["mcpServers"]
            servers.fieldNames().forEach { name ->
                val server = servers[name]
                results.add(parseSingleServer(name, server))
            }
        } else if (node.has("command")) {
            // Single server format
            val name = nameField.text.trim().ifEmpty { "mcp-server" }
            results.add(parseSingleServer(name, node))
        } else {
            // Try as a map of servers directly: {"name": {"command":"...", ...}}
            node.fieldNames().forEach { name ->
                val server = node[name]
                if (server.isObject && server.has("command")) {
                    results.add(parseSingleServer(name, server))
                }
            }
        }
        return results
    }

    private fun parseSingleServer(
        name: String,
        node: com.fasterxml.jackson.databind.JsonNode,
    ): LocalMarketplaceStore.McpEntry {
        val command = node["command"]?.asText() ?: error("Missing 'command' field for server '$name'")
        val args = mutableListOf(command)
        node["args"]?.forEach { args.add(it.asText()) }
        val env = mutableMapOf<String, String>()
        node["env"]?.fields()?.forEach { (k, v) -> env[k] = v.asText("") }
        val cwd = node["cwd"]?.asText()
        return LocalMarketplaceStore.McpEntry(
            id = name,
            argv = args,
            cwd = cwd,
            env = env,
            installedAt =
                java.time.Instant
                    .now()
                    .toString(),
        )
    }

    private fun refreshInstalled() {
        val servers = store.installedMcpServers()
        // Also include disabled ones
        val allIndex =
            try {
                val idx =
                    mapper.readTree(
                        java.nio.file.Files.readString(
                            store.globalRoot().resolve("mcps/index.json"),
                        ),
                    )
                val mcps: List<LocalMarketplaceStore.McpEntry> = mapper.readValue(idx["mcps"]?.toString() ?: "[]")
                mcps
            } catch (_: Exception) {
                servers
            }
        SwingUtilities.invokeLater {
            installedModel.clear()
            allIndex.forEach { entry ->
                val running = mcpManager.isRunning(entry.id)
                installedModel.addElement(McpServerItem(entry, running))
            }
        }
    }

    private fun startSelected() {
        val item = installedList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a server to start.", "CodePilot")
            return
        }
        try {
            mcpManager.start(
                item.entry.id,
                McpProcessManager.McpLaunchSpec(
                    id = item.entry.id,
                    argv = item.entry.argv,
                    cwd = item.entry.cwd,
                    env = item.entry.env,
                ),
            )
            status.text = "Started ${item.entry.id}."
            refreshInstalled()
            // ★ Integration: Auto-subscribe to MCP resources when server starts
            try {
                val resourcesResponse = mcpManager.call(item.entry.id, "resources/list", null)
                val resources = resourcesResponse.path("resources")
                if (resources != null && resources.isArray) {
                    for (resource in resources) {
                        val uri = resource.path("uri").asText(null)
                        if (uri != null) {
                            subscriptionManager.subscribe(item.entry.id, uri)
                        }
                    }
                }
            } catch (_: Exception) { /* Non-critical: subscription is best-effort */ }
        } catch (e: Exception) {
            Messages.showErrorDialog(project, "Failed to start: ${e.message}", "CodePilot")
        }
    }

    private fun stopSelected() {
        val item = installedList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a server to stop.", "CodePilot")
            return
        }
        mcpManager.stop(item.entry.id)
        status.text = "Stopped ${item.entry.id}."
        refreshInstalled()
    }

    private fun uninstallSelected() {
        val item = installedList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a server to uninstall.", "CodePilot")
            return
        }
        if (Messages.showOkCancelDialog(
                project,
                "Uninstall MCP server '${item.entry.id}'?",
                "CodePilot",
                "Uninstall",
                "Cancel",
                Messages.getWarningIcon(),
            ) != Messages.OK
        ) {
            return
        }
        mcpManager.stop(item.entry.id)
        store.uninstallMcp(item.entry.id)
        status.text = "Uninstalled ${item.entry.id}."
        refreshInstalled()
    }

    data class McpServerItem(
        val entry: LocalMarketplaceStore.McpEntry,
        val running: Boolean,
    )

    private class McpServerRenderer : ListCellRenderer<McpServerItem> {
        override fun getListCellRendererComponent(
            list: JList<out McpServerItem>,
            value: McpServerItem,
            index: Int,
            isSelected: Boolean,
            cellHasFocus: Boolean,
        ): java.awt.Component {
            val panel = JPanel(BorderLayout(8, 2))
            panel.isOpaque = true
            panel.background = if (isSelected) list.selectionBackground else list.background
            panel.border =
                BorderFactory.createCompoundBorder(
                    BorderFactory.createMatteBorder(0, 0, 1, 0, JBUI.CurrentTheme.CustomFrameDecorations.separatorForeground()),
                    JBUI.Borders.empty(6, 8),
                )
            val statusIcon = if (value.running) "\u25CF Running" else "\u25CB Stopped"
            val title =
                JLabel(
                    "<html><b>${value.entry.id}</b> &nbsp; <font color='${if (value.running) "green" else "gray"}'>$statusIcon</font></html>",
                )
            val cmd = value.entry.argv.joinToString(" ")
            val detail =
                JLabel(
                    "<html><code>$cmd</code>" +
                        if (value.entry.env.isNotEmpty()) {
                            "<br>env: ${value.entry.env.keys.joinToString()}"
                        } else {
                            "" +
                                "</html>"
                        },
                )
            detail.foreground = java.awt.Color.GRAY
            panel.add(title, BorderLayout.NORTH)
            panel.add(detail, BorderLayout.CENTER)
            return panel
        }
    }

    companion object {
        private val EXAMPLE_JSON =
            """
{
  "mcpServers": {
    "example-server": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": {
        "API_KEY": "your-api-key-here"
      }
    }
  }
}
            """.trimIndent()
    }
}
