package io.codepilot.plugin.marketplace

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane

/** In-IDE Skill authoring panel; writes a fresh user Skill yaml under the chosen scope. */
class NewSkillPanel(
    private val project: Project,
    private val store: LocalMarketplaceStore,
    private val onChanged: () -> Unit,
) {

    private val idField = JBTextField("skill.user.my-skill")
    private val versionField = JBTextField("0.1.0")
    private val titleField = JBTextField("My local skill")
    private val scopeBox = JComboBox(arrayOf("project", "global"))
    private val languageField = JBTextField("java")
    private val actionField = JBTextField("")
    private val promptArea = JBTextArea(10, 40).apply {
        text = "Your instructions to the model go here. Keep under ~500 tokens."
    }
    private val save = JButton("Create")

    val component: JComponent =
        JPanel(GridBagLayout()).apply {
            border = JBUI.Borders.empty(8)
            addRow(this, 0, "Id:", idField)
            addRow(this, 1, "Version:", versionField)
            addRow(this, 2, "Title:", titleField)
            addRow(this, 3, "Scope:", scopeBox)
            addRow(this, 4, "language (optional):", languageField)
            addRow(this, 5, "action (optional):", actionField)
            addRow(this, 6, "Prompt:", JScrollPane(promptArea))
            val gbc = GridBagConstraints().apply {
                gridx = 1; gridy = 7; weightx = 1.0; fill = GridBagConstraints.HORIZONTAL
                insets = Insets(8, 4, 4, 4)
            }
            save.addActionListener { save() }
            add(save, gbc)
        }

    private fun save() {
        val id = idField.text.trim()
        val version = versionField.text.trim()
        val prompt = promptArea.text
        if (id.isEmpty() || version.isEmpty() || prompt.isBlank()) {
            Messages.showErrorDialog(project, "id, version and prompt are required.", "CodePilot")
            return
        }
        val scope = if (scopeBox.selectedItem == "global") LocalMarketplaceStore.Scope.GLOBAL else LocalMarketplaceStore.Scope.PROJECT
        val yaml = buildYaml(id, version, titleField.text.trim().ifEmpty { id }, scope.value, prompt,
            languageField.text.trim().ifEmpty { null }, actionField.text.trim().ifEmpty { null })
        runCatching {
            store.installSkill(scope, project, id, version, LocalMarketplaceStore.Source.BUILTIN_IDE, yaml)
        }.onSuccess {
            Messages.showInfoMessage(project, "Created ${id}@${version} under ${scope.value}.", "CodePilot")
            onChanged()
        }.onFailure {
            Messages.showErrorDialog(project, it.message ?: "create failed", "CodePilot")
        }
    }

    private fun buildYaml(id: String, version: String, title: String, scope: String, prompt: String, language: String?, action: String?): String =
        buildString {
            appendLine("id: $id")
            appendLine("version: $version")
            appendLine("title: \"${title.replace("\"", "\\\"")}\"")
            appendLine("source: user")
            appendLine("scope: $scope")
            if (!language.isNullOrBlank() || !action.isNullOrBlank()) {
                appendLine("triggers:")
                appendLine("  any:")
                language?.let { appendLine("    - language: [$it]") }
                action?.let { appendLine("    - action: [$it]") }
            }
            appendLine("systemPrompt: |")
            prompt.lineSequence().forEach { appendLine("  $it") }
        }

    private fun addRow(parent: JPanel, row: Int, label: String, component: JComponent) {
        val lbl = JLabel(label)
        val gL = GridBagConstraints().apply { gridx = 0; gridy = row; insets = Insets(4, 4, 4, 4) }
        val gR = GridBagConstraints().apply { gridx = 1; gridy = row; weightx = 1.0; fill = GridBagConstraints.HORIZONTAL; insets = Insets(4, 4, 4, 4) }
        parent.add(lbl, gL)
        parent.add(component, gR)
    }
}