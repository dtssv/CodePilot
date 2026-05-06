package io.codepilot.plugin.marketplace

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import io.codepilot.plugin.settings.CodePilotSettings
import io.codepilot.plugin.settings.RegistryEntry
import java.awt.BorderLayout
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Marketplace Tab. Displays official packages, lets the user install/uninstall to project/global,
 * and supports creating a brand-new user Skill locally (never uploaded).
 */
class MarketplacePanel(private val project: Project) {

    private val client = MarketplaceClient()
    private val store = LocalMarketplaceStore.getInstance()
    private val settings = CodePilotSettings.getInstance()

    /** Registry selector for switching between official and third-party registries. */
    private val registrySelector = JComboBox<String>().apply {
        settings.state.registries.forEach { addItem(it.name) }
        addActionListener { refreshOfficial() }
    }

    private val officialListModel = DefaultListModel<MarketplaceClient.Package>()
    private val officialList = JBList(officialListModel).apply {
        cellRenderer = PackageRenderer()
    }

    private val installedListModel = DefaultListModel<LocalMarketplaceStore.ActiveSkill>()
    private val installedList = JBList(installedListModel).apply {
        cellRenderer = InstalledRenderer()
    }

    private val status = JLabel(" ")

    init {
        refresh()
    }

    val component: JComponent =
        JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(4)
            val tabs = JBTabbedPane()
            tabs.addTab("Marketplace", buildOfficialPane())
            tabs.addTab("Installed", buildInstalledPane())
            tabs.addTab("New user Skill", NewSkillPanel(project, store, ::refresh).component)
            add(tabs, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }

    private fun buildOfficialPane(): JComponent {
        val north = JPanel().apply {
            add(JLabel("Registry: "))
            add(registrySelector)
        }
        val south = JPanel().apply {
            add(JButton("Refresh").apply { addActionListener { refresh() } })
            add(JButton("Install to project").apply { addActionListener { install(LocalMarketplaceStore.Scope.PROJECT) } })
            add(JButton("Install to global").apply { addActionListener { install(LocalMarketplaceStore.Scope.GLOBAL) } })
        }
        return JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(officialList), BorderLayout.CENTER)
            add(south, BorderLayout.SOUTH)
        }
    }

    private fun buildInstalledPane(): JComponent {
        val south = JPanel().apply {
            add(JButton("Disable").apply { addActionListener { toggle(false) } })
            add(JButton("Enable").apply { addActionListener { toggle(true) } })
            add(JButton("Uninstall").apply { addActionListener { uninstall() } })
        }
        return JPanel(BorderLayout()).apply {
            add(JBScrollPane(installedList), BorderLayout.CENTER)
            add(south, BorderLayout.SOUTH)
        }
    }

    private fun refresh() {
        refreshOfficial()
        refreshInstalled()
    }

    private fun refreshOfficial() {
        status.text = "Loading marketplace…"
        val selectedIdx = registrySelector.selectedIndex.coerceAtLeast(0)
        val registries = settings.state.registries
        val registryUrl = if (selectedIdx < registries.size) registries[selectedIdx].url else null

        client.listPackages(type = "skill").whenComplete { list, err ->
            SwingUtilities.invokeLater {
                officialListModel.clear()
                if (err != null) {
                    status.text = "Marketplace unreachable: ${err.message}"
                    return@invokeLater
                }
                list.forEach(officialListModel::addElement)
                val regName = registrySelector.selectedItem ?: "official"
                status.text = "${list.size} packages from $regName"
            }
        }
    }

    private fun refreshInstalled() {
        val list = store.activeSkills(project)
        SwingUtilities.invokeLater {
            installedListModel.clear()
            list.forEach(installedListModel::addElement)
        }
    }

    private fun install(scope: LocalMarketplaceStore.Scope) {
        val selected = officialList.selectedValue ?: return
        val version = selected.latestVersion ?: return
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
            client.reportInstall(selected.slug, version, scope, LocalMarketplaceStore.Source.OFFICIAL)
                .whenComplete { _, _ ->
                    ApplicationManager.getApplication().invokeLater {
                        status.text = "Installed ${selected.slug}@$version into ${scope.value}."
                        refreshInstalled()
                    }
                }
        }
    }

    private fun toggle(enable: Boolean) {
        val selected = installedList.selectedValue ?: return
        val scope = LocalMarketplaceStore.Scope.entries.first { it.value == selected.scope }
        store.setSkillEnabled(scope, project, selected.entry.id, selected.entry.version, enable)
        refreshInstalled()
    }

    private fun uninstall() {
        val selected = installedList.selectedValue ?: return
        val scope = LocalMarketplaceStore.Scope.entries.first { it.value == selected.scope }
        if (Messages.showOkCancelDialog(
                project,
                "Uninstall ${selected.entry.id}@${selected.entry.version} from ${selected.scope}?",
                "CodePilot",
                "Uninstall",
                "Cancel",
                Messages.getWarningIcon(),
            ) != Messages.OK
        ) return
        store.uninstallSkill(scope, project, selected.entry.id, selected.entry.version)
        client.reportUninstall(
            selected.entry.id,
            selected.entry.version,
            scope,
            LocalMarketplaceStore.Source.entries.first { it.value == selected.entry.source },
        )
        refreshInstalled()
    }

    /**
     * Builds a minimal Skill yaml from the marketplace metadata. In production the real payload
     * is downloaded from the signed artifact URL; for the official registry, we synthesise a
     * placeholder that is clearly marked as 'system' so it is never injected as a user Skill.
     */
    private fun buildYaml(pkg: MarketplaceClient.Package, version: String, manifest: Map<String, Any?>): String {
        return buildString {
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
}