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
                            "Copy the JSON from the MCP Server's docs page. Supports stdio (npx, uvx, node, python), SSE, and Streamable HTTP.<br>" +
                            "Stdio: <code>{\"mcpServers\":{\"name\":{\"command\":\"npx\",\"args\":[...]}}}</code><br>" +
                            "SSE/HTTP: <code>{\"mcpServers\":{\"name\":{\"url\":\"https://...\"}}}</code></html>",
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
     * Parses MCP JSON config. Supports three transport modes and multiple formats:
     *
     * Transport modes:
     * - stdio: {"command":"npx","args":[...],"env":{...}}
     * - SSE:   {"url":"https://..."}
     * - Streamable HTTP: {"url":"https://..."}
     *
     * Formats:
     * 1. Standard: {"mcpServers":{"name":{...}}}
     * 2. Single server: {"command":"..."} or {"url":"..."}
     * 3. Direct map: {"name":{...}}
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
        } else if (node.has("command") || node.has("url")) {
            // Single server format (stdio or SSE/HTTP)
            val name = nameField.text.trim().ifEmpty { "mcp-server" }
            results.add(parseSingleServer(name, node))
        } else {
            // Try as a map of servers directly: {"name": {"command":"..."|"url":"..."}}
            node.fieldNames().forEach { name ->
                val server = node[name]
                if (server.isObject && (server.has("command") || server.has("url"))) {
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
        val url = node["url"]?.asText()
        val command = node["command"]?.asText()

        // Determine transport mode
        val transport = when {
            url != null && command == null -> detectTransportFromUrl(url)
            else -> LocalMarketplaceStore.McpTransport.STDIO
        }

        // Parse common fields
        val env = mutableMapOf<String, String>()
        node["env"]?.fields()?.forEach { (k, v) -> env[k] = v.asText("") }
        val headers = mutableMapOf<String, String>()
        node["headers"]?.fields()?.forEach { (k, v) -> headers[k] = v.asText("") }

        if (transport == LocalMarketplaceStore.McpTransport.STDIO) {
            // stdio mode: command is required
            val cmd = command ?: error("Missing 'command' field for stdio server '$name'")
            val args = mutableListOf<String>()
            node["args"]?.forEach { args.add(it.asText()) }
            val cwd = node["cwd"]?.asText()
            return LocalMarketplaceStore.McpEntry(
                id = name,
                argv = buildList {
                    add(cmd)
                    addAll(args)
                },
                cwd = cwd,
                env = env,
                transport = transport,
                url = url,
                headers = headers,
                installedAt = java.time.Instant
                    .now()
                    .toString(),
            )
        } else {
            // SSE / Streamable HTTP mode: url is required
            val serverUrl = url ?: error("Missing 'url' field for remote server '$name'")
            return LocalMarketplaceStore.McpEntry(
                id = name,
                argv = emptyList(),
                env = env,
                transport = transport,
                url = serverUrl,
                headers = headers,
                installedAt = java.time.Instant
                    .now()
                    .toString(),
            )
        }
    }

    /** Detect transport mode from URL pattern. SSE typically uses /sse endpoint. */
    private fun detectTransportFromUrl(url: String): LocalMarketplaceStore.McpTransport {
        val lower = url.lowercase()
        return if (lower.contains("/sse") || lower.contains("eventsource")) {
            LocalMarketplaceStore.McpTransport.SSE
        } else {
            LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP
        }
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
        status.text = "Starting ${item.entry.id}..."
        val serverId = item.entry.id
        Thread({
            try {
                when (item.entry.transport) {
                    LocalMarketplaceStore.McpTransport.STDIO -> {
                        mcpManager.start(
                            item.entry.id,
                            McpProcessManager.McpLaunchSpec(
                                id = item.entry.id,
                                argv = item.entry.argv,
                                cwd = item.entry.cwd,
                                env = item.entry.env,
                            ),
                        )
                    }
                    LocalMarketplaceStore.McpTransport.SSE,
                    LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP,
                    -> {
                        val url = item.entry.url
                            ?: error("Missing URL for remote MCP server '${item.entry.id}'")
                        mcpManager.startRemote(
                            item.entry.id,
                            url,
                            item.entry.transport,
                            item.entry.headers,
                        )
                    }
                }
                // Delay to allow process startup to complete
                Thread.sleep(1500)
                refreshInstalled()
                // Verify the server is actually running after refresh
                val actuallyRunning = mcpManager.isRunning(serverId)
                if (!actuallyRunning) {
                    SwingUtilities.invokeLater {
                        status.text = "Failed to start $serverId — process exited immediately."
                    }
                } else {
                    SwingUtilities.invokeLater {
                        status.text = "Started $serverId."
                    }
                    // ★ Integration: Auto-subscribe to MCP resources when server starts
                    try {
                        val resourcesResponse = mcpManager.call(serverId, "resources/list", null)
                        val resources = resourcesResponse.path("resources")
                        if (resources != null && resources.isArray) {
                            for (resource in resources) {
                                val uri = resource.path("uri").asText(null)
                                if (uri != null) {
                                    subscriptionManager.subscribe(serverId, uri)
                                }
                            }
                        }
                    } catch (_: Exception) {
                        /* Non-critical: subscription is best-effort */
                    }
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    Messages.showErrorDialog(project, "Failed to start: ${e.message}", "CodePilot")
                }
            }
        }, "mcp-start-$serverId").apply {
            isDaemon = true
            start()
        }
    }

    private fun stopSelected() {
        val item = installedList.selectedValue
        if (item == null) {
            Messages.showWarningDialog(project, "Select a server to stop.", "CodePilot")
            return
        }
        val serverId = item.entry.id
        status.text = "Stopping $serverId..."
        Thread({
            mcpManager.stop(serverId)
            refreshInstalled()
            SwingUtilities.invokeLater {
                status.text = "Stopped $serverId."
            }
        }, "mcp-stop-$serverId").apply {
            isDaemon = true
            start()
        }
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
        val serverId = item.entry.id
        status.text = "Uninstalling $serverId..."
        Thread({
            mcpManager.stop(serverId)
            store.uninstallMcp(serverId)
            refreshInstalled()
            SwingUtilities.invokeLater {
                status.text = "Uninstalled $serverId."
            }
        }, "mcp-uninstall-$serverId").apply {
            isDaemon = true
            start()
        }
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
            val transportLabel = when (value.entry.transport) {
                LocalMarketplaceStore.McpTransport.STDIO -> "stdio"
                LocalMarketplaceStore.McpTransport.SSE -> "SSE"
                LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP -> "Streamable HTTP"
            }
            val title =
                JLabel(
                    "<html><b>${value.entry.id}</b> &nbsp; <font color='blue'>[$transportLabel]</font> &nbsp; <font color='${if (value.running) "green" else "gray"}'>$statusIcon</font></html>",
                )
            val detailText = when (value.entry.transport) {
                LocalMarketplaceStore.McpTransport.STDIO -> {
                    val cmd = value.entry.argv.joinToString(" ")
                    "<html><code>$cmd</code>" +
                        if (value.entry.env.isNotEmpty()) {
                            "<br>env: ${value.entry.env.keys.joinToString()}"
                        } else {
                            ""
                        } + "</html>"
                }
                LocalMarketplaceStore.McpTransport.SSE,
                LocalMarketplaceStore.McpTransport.STREAMABLE_HTTP,
                -> {
                    val url = value.entry.url ?: ""
                    "<html><code>$url</code>" +
                        if (value.entry.headers.isNotEmpty()) {
                            "<br>headers: ${value.entry.headers.keys.joinToString()}"
                        } else {
                            ""
                        } + "</html>"
                }
            }
            val detail = JLabel(detailText)
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
    },
    "remote-sse": {
      "url": "https://mcp.example.com/sse"
    },
    "remote-http": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
            """.trimIndent()
    }
}
