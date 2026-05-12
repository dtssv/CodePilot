package io.codepilot.plugin.marketplace

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.*

/**
 * NewSkillWizard — 7-step Skill authoring wizard.
 *
 * Steps:
 * 1. Identity: id, version, title, scope
 * 2. Trigger: trigger patterns (regex/glob/keyword)
 * 3. Language & Action: target language, action type
 * 4. Context: workspace probe rules, required context
 * 5. Prompt: system prompt template with {{variables}}
 * 6. Permissions: tool access, path guards
 * 7. Review & Create: summary, validation, create
 */
class NewSkillWizard(
    private val project: Project,
    private val store: LocalMarketplaceStore,
    private val onChanged: () -> Unit,
) : DialogWrapper(true) {

    private val cardLayout = CardLayout()
    private val cardPanel = JPanel(cardLayout)
    private var currentStep = 0
    private val totalSteps = 7

    // Step 1: Identity
    private val idField = JBTextField("skill.user.my-skill")
    private val versionField = JBTextField("0.1.0")
    private val titleField = JBTextField("My local skill")
    private val scopeBox = JComboBox(arrayOf("project", "global"))

    // Step 2: Trigger
    private val triggerTypeBox = JComboBox(arrayOf("keyword", "regex", "glob"))
    private val triggerPatternField = JBTextField("")
    private val triggerDescArea = JBTextArea(3, 40).apply { lineWrap = true; wrapStyleWord = true }

    // Step 3: Language & Action
    private val languageField = JBTextField("")
    private val actionField = JBTextField("")

    // Step 4: Context
    private val probeField = JBTextField("")
    private val contextArea = JBTextArea(3, 40).apply { lineWrap = true; wrapStyleWord = true; text = "selectedText, currentFile" }

    // Step 5: Prompt
    private val promptArea = JBTextArea(10, 50).apply {
        text = "You are a helpful coding assistant.\nUser request: {{instruction}}\nSelected code:\n```\n{{selection}}\n```\nFile: {{filePath}} ({{language}})"
        lineWrap = true; wrapStyleWord = true
    }

    // Step 6: Permissions
    private val toolsArea = JBTextArea(2, 40).apply { text = "shell.exec, fs.read"; lineWrap = true }
    private val pathGuardField = JBTextField("")

    // Step 7: Review
    private val reviewArea = JBTextArea(15, 50).apply { isEditable = false; lineWrap = true }

    // Navigation
    private val prevButton = JButton("< Previous")
    private val nextButton = JButton("Next >")
    private val stepLabel = JLabel()

    init {
        title = "Create New Skill"
        init()
        updateStepUI()
    }

    override fun createCenterPanel(): JComponent {
        // Build all step panels
        cardPanel.add(buildStep1(), "1")
        cardPanel.add(buildStep2(), "2")
        cardPanel.add(buildStep3(), "3")
        cardPanel.add(buildStep4(), "4")
        cardPanel.add(buildStep5(), "5")
        cardPanel.add(buildStep6(), "6")
        cardPanel.add(buildStep7(), "7")

        val navPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 4)).apply {
            add(stepLabel)
            add(prevButton)
            add(nextButton)
        }

        prevButton.addActionListener { if (currentStep > 0) { currentStep--; updateStepUI() } }
        nextButton.addActionListener {
            if (currentStep < totalSteps - 1) {
                currentStep++
                if (currentStep == totalSteps - 1) generateReview()
                updateStepUI()
            } else {
                // Create
                createSkill()
            }
        }

        return JPanel(BorderLayout(8, 8)).apply {
            add(cardPanel, BorderLayout.CENTER)
            add(navPanel, BorderLayout.SOUTH)
        }
    }

    private fun buildStep1(): JPanel = stepPanel("Step 1/7: Identity") { gbl, panel ->
        addRow(panel, 0, "Skill ID:", idField, gbl)
        addRow(panel, 1, "Version:", versionField, gbl)
        addRow(panel, 2, "Title:", titleField, gbl)
        addRow(panel, 3, "Scope:", scopeBox, gbl)
    }

    private fun buildStep2(): JPanel = stepPanel("Step 2/7: Trigger") { gbl, panel ->
        addRow(panel, 0, "Trigger Type:", triggerTypeBox, gbl)
        addRow(panel, 1, "Pattern:", triggerPatternField, gbl)
        addLabeledArea(panel, 2, "Description:", triggerDescArea, gbl)
    }

    private fun buildStep3(): JPanel = stepPanel("Step 3/7: Language & Action") { gbl, panel ->
        addRow(panel, 0, "Language (optional):", languageField, gbl)
        addRow(panel, 1, "Action (optional):", actionField, gbl)
    }

    private fun buildStep4(): JPanel = stepPanel("Step 4/7: Context") { gbl, panel ->
        addRow(panel, 0, "Workspace Probe:", probeField, gbl)
        addLabeledArea(panel, 1, "Required Context:", contextArea, gbl)
    }

    private fun buildStep5(): JPanel = stepPanel("Step 5/7: Prompt Template") { gbl, panel ->
        addLabeledArea(panel, 0, "Prompt:", promptArea, gbl)
        panel.add(JLabel("Variables: {{instruction}}, {{selection}}, {{filePath}}, {{language}}").apply {
            foreground = java.awt.Color.GRAY
        }, GridBagConstraints().apply { gridy = 1; gridx = 0; gridwidth = 2; insets = Insets(4, 4, 4, 4) })
    }

    private fun buildStep6(): JPanel = stepPanel("Step 6/7: Permissions") { gbl, panel ->
        addLabeledArea(panel, 0, "Allowed Tools:", toolsArea, gbl)
        addRow(panel, 1, "Path Guard:", pathGuardField, gbl)
    }

    private fun buildStep7(): JPanel = stepPanel("Step 7/7: Review & Create") { gbl, panel ->
        addLabeledArea(panel, 0, "Skill Preview:", reviewArea, gbl)
    }

    private fun stepPanel(title: String, body: (GridBagLayout, JPanel) -> Unit): JPanel {
        val gbl = GridBagLayout()
        val panel = JPanel(gbl).apply { border = JBUI.Borders.empty(12) }
        val titleLabel = JLabel("<html><h3>$title</h3></html>")
        panel.add(titleLabel, GridBagConstraints().apply {
            gridy = 0; gridx = 0; gridwidth = 2; insets = Insets(0, 0, 12, 0); anchor = GridBagConstraints.WEST
        })
        // Shift body rows down by 1
        body(gbl, panel)
        return panel
    }

    private fun addRow(panel: JPanel, row: Int, label: String, field: JComponent, gbl: GridBagLayout) {
        val actualRow = row + 1 // offset for title
        panel.add(JLabel(label), GridBagConstraints().apply {
            gridy = actualRow; gridx = 0; anchor = GridBagConstraints.WEST; insets = Insets(4, 4, 4, 4)
        })
        panel.add(field, GridBagConstraints().apply {
            gridy = actualRow; gridx = 1; fill = GridBagConstraints.HORIZONTAL; weightx = 1.0; insets = Insets(4, 4, 4, 4)
        })
    }

    private fun addLabeledArea(panel: JPanel, row: Int, label: String, area: JBTextArea, gbl: GridBagLayout) {
        val actualRow = row + 1
        panel.add(JLabel(label), GridBagConstraints().apply {
            gridy = actualRow; gridx = 0; anchor = GridBagConstraints.NORTHWEST; insets = Insets(4, 4, 4, 4)
        })
        panel.add(JBScrollPane(area), GridBagConstraints().apply {
            gridy = actualRow; gridx = 1; fill = GridBagConstraints.BOTH; weightx = 1.0; weighty = 1.0; insets = Insets(4, 4, 4, 4)
        })
    }

    private fun updateStepUI() {
        cardLayout.show(cardPanel, (currentStep + 1).toString())
        stepLabel.text = "Step ${currentStep + 1} of $totalSteps"
        prevButton.isEnabled = currentStep > 0
        nextButton.text = if (currentStep == totalSteps - 1) "Create" else "Next >"
    }

    private fun generateReview() {
        val yaml = buildString {
            appendLine("id: ${idField.text}")
            appendLine("version: ${versionField.text}")
            appendLine("title: ${titleField.text}")
            appendLine("scope: ${scopeBox.selectedItem}")
            appendLine("trigger:")
            appendLine("  type: ${triggerTypeBox.selectedItem}")
            appendLine("  pattern: ${triggerPatternField.text}")
            if (triggerDescArea.text.isNotBlank()) appendLine("  description: ${triggerDescArea.text}")
            if (languageField.text.isNotBlank()) appendLine("language: ${languageField.text}")
            if (actionField.text.isNotBlank()) appendLine("action: ${actionField.text}")
            if (probeField.text.isNotBlank()) appendLine("probe: ${probeField.text}")
            if (contextArea.text.isNotBlank()) appendLine("context: ${contextArea.text}")
            appendLine("prompt: |")
            promptArea.text.lines().forEach { appendLine("  $it") }
            appendLine("permissions:")
            appendLine("  tools: ${toolsArea.text}")
            if (pathGuardField.text.isNotBlank()) appendLine("  pathGuard: ${pathGuardField.text}")
        }
        reviewArea.text = yaml
    }

    private fun createSkill() {
        val scope = scopeBox.selectedItem as String
        val id = idField.text
        val version = versionField.text.trim().ifBlank { "0.1.0" }
        val yaml = reviewArea.text
        val skillScope = LocalMarketplaceStore.Scope.valueOf(scope.uppercase())
        store.installSkill(skillScope, project, id, version, LocalMarketplaceStore.Source.LOCAL, yaml)
        onChanged()
        close(OK_EXIT_CODE)
    }

    override fun doValidate(): ValidationInfo? {
        if (currentStep == 0 && idField.text.isBlank()) return ValidationInfo("Skill ID is required", idField)
        return null
    }
}