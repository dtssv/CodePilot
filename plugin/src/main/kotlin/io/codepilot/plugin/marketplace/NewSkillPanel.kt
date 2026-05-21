package io.codepilot.plugin.marketplace

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

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
    private val languageField = JBTextField("")
    private val actionField = JBTextField("")
    private val promptArea =
        JBTextArea(12, 50).apply {
            text = "Your instructions to the model go here. Keep under ~500 tokens."
            lineWrap = true
            wrapStyleWord = true
        }
    private val save = JButton("Create")

    val component: JComponent =
        JPanel(GridBagLayout()).apply {
            border = JBUI.Borders.empty(8)
            addRow(this, 0, "Id:", idField)
            addRow(this, 1, "Version:", versionField)
            addRow(this, 2, "Title:", titleField)
            addRow(this, 3, "Scope:", scopeBox)
            addRow(this, 4, "Language (optional):", languageField)
            addRow(this, 5, "Action (optional):", actionField)

            // Prompt label
            val promptLabelGbc =
                GridBagConstraints().apply {
                    gridx = 0
                    gridy = 6
                    anchor = GridBagConstraints.NORTHWEST
                    insets = Insets(4, 4, 4, 4)
                }
            add(JLabel("Prompt:"), promptLabelGbc)

            // Prompt text area with scroll pane — fill both directions
            val promptGbc =
                GridBagConstraints().apply {
                    gridx = 1
                    gridy = 6
                    weightx = 1.0
                    weighty = 1.0
                    fill = GridBagConstraints.BOTH
                    insets = Insets(4, 4, 4, 4)
                }
            add(JBScrollPane(promptArea), promptGbc)

            // Create button
            val btnGbc =
                GridBagConstraints().apply {
                    gridx = 1
                    gridy = 7
                    weightx = 1.0
                    fill = GridBagConstraints.HORIZONTAL
                    insets = Insets(8, 4, 4, 4)
                }
            save.addActionListener { save() }
            add(save, btnGbc)

            // ★ Integration: NewSkillWizard 7-step advanced authoring
            val wizardBtn = JButton("Advanced Wizard")
            wizardBtn.addActionListener {
                val wizard = NewSkillWizard(project, store, onChanged)
                wizard.show()
            }
            val wizardGbc = GridBagConstraints().apply {
                gridx = 2; gridy = 8
                anchor = GridBagConstraints.WEST
                insets = Insets(8, 4, 4, 4)
            }
            add(wizardBtn, wizardGbc)
        }

    private fun save() {
        val id = idField.text.trim()
        val version = versionField.text.trim()
        val prompt = promptArea.text
        val scope = if (scopeBox.selectedItem == "global") LocalMarketplaceStore.Scope.GLOBAL else LocalMarketplaceStore.Scope.PROJECT
        LocalSkillCreator.create(
            project,
            id,
            version,
            titleField.text.trim(),
            scope,
            languageField.text.trim().ifEmpty { null },
            actionField.text.trim().ifEmpty { null },
            prompt,
        ).onSuccess {
            Messages.showInfoMessage(project, "Created $id@$version under ${scope.value}.", "CodePilot")
            onChanged()
        }.onFailure {
            Messages.showErrorDialog(project, it.message ?: "create failed", "CodePilot")
        }
    }

    private fun addRow(
        parent: JPanel,
        row: Int,
        label: String,
        component: JComponent,
    ) {
        val lbl = JLabel(label)
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
        parent.add(lbl, gL)
        parent.add(component, gR)
    }
}
