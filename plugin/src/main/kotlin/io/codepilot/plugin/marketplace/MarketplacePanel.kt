package io.codepilot.plugin.marketplace

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.settings.CodePilotSettings
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Marketplace Tab. Supports:
 *   - Browsing & searching Skills from multiple registries (Official + third-party Skill Hubs)
 *   - Installing Skills to project or global scope
 *   - Viewing installed Skills with empty-state feedback
 *   - Creating new user Skills locally
 */
class MarketplacePanel(
    private val project: Project,
) {
    private val client = MarketplaceClient()
    private val store = LocalMarketplaceStore.getInstance()
    private val settings = CodePilotSettings.getInstance()

    /** Registry selector for switching between official and third-party registries. */
    private val registrySelector =
        JComboBox<String>().apply {
            settings.state.registries.forEach { addItem(it.name) }
            addActionListener { refreshMarketplace() }
        }

    /** Search field for filtering packages. */
    private val searchField =
        JBTextField(20).apply {
            emptyText.text = "Search skills..."
        }

    private val officialListModel = DefaultListModel<MarketplaceClient.Package>()
    private val officialList =
        JBList(officialListModel).apply {
            cellRenderer = PackageRenderer()
            emptyText.text = "No packages found. Try a different registry or search."
        }

    private val installedListModel = DefaultListModel<LocalMarketplaceStore.ActiveSkill>()
    private val installedList =
        JBList(installedListModel).apply {
            cellRenderer = InstalledRenderer()
            emptyText.text = "No skills installed yet. Browse Marketplace or create a new Skill."
        }

    private val status = JLabel(" ")

    init {
        refresh()
    }

    val component: JComponent =
        JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4)
            val tabs = JBTabbedPane()
            tabs.addTab("Marketplace", buildMarketplacePane())
            tabs.addTab("Installed", buildInstalledPane())
            tabs.addTab("New Skill", NewSkillPanel(project, store, ::refresh).component)
            add(tabs, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }

    private fun buildMarketplacePane(): JComponent {
        val north =
            JPanel(BorderLayout()).apply {
                border = JBUI.Borders.emptyBottom(4)
                val registryRow =
                    JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
                        add(JLabel("Registry:"))
                        add(registrySelector)
                    }
                val searchRow =
                    JPanel(BorderLayout(4, 0)).apply {
                        add(searchField, BorderLayout.CENTER)
                        add(
                            JButton("Search").apply {
                                addActionListener { refreshMarketplace() }
                            },
                            BorderLayout.EAST,
                        )
                    }
                add(registryRow, BorderLayout.WEST)
                add(searchRow, BorderLayout.CENTER)
            }
        val south =
            JPanel(FlowLayout(FlowLayout.LEFT, 4, 4)).apply {
                add(JButton("Refresh").apply { addActionListener { refresh() } })
                add(JButton("Install to Project").apply { addActionListener { install(LocalMarketplaceStore.Scope.PROJECT) } })
                add(JButton("Install to Global").apply { addActionListener { install(LocalMarketplaceStore.Scope.GLOBAL) } })
            }
        return JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(officialList), BorderLayout.CENTER)
            add(south, BorderLayout.SOUTH)
        }
    }

    private fun buildInstalledPane(): JComponent {
        val north =
            JPanel(FlowLayout(FlowLayout.LEFT, 4, 4)).apply {
                add(JButton("Refresh").apply { addActionListener { refreshInstalled() } })
                add(JButton("Enable").apply { addActionListener { toggle(true) } })
                add(JButton("Disable").apply { addActionListener { toggle(false) } })
                add(JButton("Uninstall").apply { addActionListener { uninstall() } })
            }
        return JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(installedList), BorderLayout.CENTER)
        }
    }

    private fun refresh() {
        refreshMarketplace()
        refreshInstalled()
    }

    private fun refreshMarketplace() {
        status.text = "Loading marketplace…"
        val query = searchField.text.trim().ifEmpty { null }

        client.listPackages(type = "skill", query = query).whenComplete { list, err ->
            SwingUtilities.invokeLater {
                officialListModel.clear()
                if (err != null) {
                    status.text = "Marketplace unreachable: ${err.message}"
                    return@invokeLater
                }
                list.forEach(officialListModel::addElement)
                val regName = registrySelector.selectedItem ?: "official"
                status.text = "${list.size} packages from $regName" +
                    if (query != null) " (filtered: \"$query\")" else ""
            }
        }
    }

    private fun refreshInstalled() {
        val list = store.activeSkills(project)
        SwingUtilities.invokeLater {
            installedListModel.clear()
            if (list.isEmpty()) {
                // Empty state is handled by JBList.emptyText
            } else {
                list.forEach(installedListModel::addElement)
            }
        }
    }

    private fun install(scope: LocalMarketplaceStore.Scope) {
        val selected = officialList.selectedValue
        if (selected == null) {
            Messages.showWarningDialog(project, "Please select a package to install.", "CodePilot")
            return
        }
        val version = selected.latestVersion
        if (version == null) {
            Messages.showWarningDialog(project, "No published version available for ${selected.slug}.", "CodePilot")
            return
        }
        status.text = "Installing ${selected.slug}@$version…"
        client.manifest(selected.slug, version).whenComplete { manifest, err ->
            if (err != null) {
                ApplicationManager.getApplication().invokeLater {
                    status.text = "Manifest fetch failed: ${err.message}"
                }
                return@whenComplete
            }
            val yaml = buildYaml(selected, version, manifest)
            runCatching {
                store.installSkill(scope, project, selected.slug, version, LocalMarketplaceStore.Source.OFFICIAL, yaml)
            }.onFailure { t ->
                ApplicationManager.getApplication().invokeLater {
                    Messages.showErrorDialog(project, t.message ?: "install failed", "CodePilot")
                }
                return@whenComplete
            }
            client
                .reportInstall(selected.slug, version, scope, LocalMarketplaceStore.Source.OFFICIAL)
                .whenComplete { _, _ ->
                    ApplicationManager.getApplication().invokeLater {
                        status.text = "Installed ${selected.slug}@$version into ${scope.value}."
                        refreshInstalled()
                    }
                }
        }
    }

    private fun toggle(enable: Boolean) {
        val selected = installedList.selectedValue
        if (selected == null) {
            Messages.showWarningDialog(project, "Please select an installed skill.", "CodePilot")
            return
        }
        val scope = LocalMarketplaceStore.Scope.entries.first { it.value == selected.scope }
        store.setSkillEnabled(scope, project, selected.entry.id, selected.entry.version, enable)
        refreshInstalled()
        status.text = "${selected.entry.id} ${if (enable) "enabled" else "disabled"}."
    }

    private fun uninstall() {
        val selected = installedList.selectedValue
        if (selected == null) {
            Messages.showWarningDialog(project, "Please select an installed skill.", "CodePilot")
            return
        }
        val scope = LocalMarketplaceStore.Scope.entries.first { it.value == selected.scope }
        if (Messages.showOkCancelDialog(
                project,
                "Uninstall ${selected.entry.id}@${selected.entry.version} from ${selected.scope}?",
                "CodePilot",
                "Uninstall",
                "Cancel",
                Messages.getWarningIcon(),
            ) != Messages.OK
        ) {
            return
        }
        store.uninstallSkill(scope, project, selected.entry.id, selected.entry.version)
        client.reportUninstall(
            selected.entry.id,
            selected.entry.version,
            scope,
            LocalMarketplaceStore.Source.entries.first { it.value == selected.entry.source },
        )
        refreshInstalled()
        status.text = "Uninstalled ${selected.entry.id}."
    }

    /**
     * Builds a minimal Skill yaml from the marketplace metadata. In production the real payload
     * is downloaded from the signed artifact URL.
     */
    private fun buildYaml(
        pkg: MarketplaceClient.Package,
        version: String,
        manifest: Map<String, Any?>,
    ): String =
        buildString {
            appendLine("id: ${pkg.slug}")
            appendLine("version: $version")
            appendLine("title: ${pkg.name.replace("\"", "\\\"")}")
            appendLine("source: user")
            appendLine("scope: project")
            appendLine("systemPrompt: |")
            val preview = manifest["description"]?.toString()?.ifBlank { pkg.description.orEmpty() }
            val body = preview ?: "Behavioural cues for ${pkg.name}."
            body.lineSequence().forEach { appendLine("  $it") }
        }
}
