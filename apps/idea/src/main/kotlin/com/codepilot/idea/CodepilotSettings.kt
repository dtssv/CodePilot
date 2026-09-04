package com.codepilot.idea

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import java.awt.BorderLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.SwingConstants

/** Persistent application-level settings. Stored in `~/.config/JetBrains/<IDE>/options/codepilot.xml`. */
@State(
    name = "CodePilotSettings",
    storages = [Storage("codepilot.xml")]
)
@Service(Service.Level.APP)
class CodepilotSettings : PersistentStateComponent<CodepilotSettings.State> {
    data class State(
        var codepilotPath: String = "codepilot",
        var model: String = "",
        var permissionMode: String = "ask", // ask | auto-edit | yolo
        var defaultMode: String = "agent", // chat | plan | agent — default collaboration mode for new sessions
        var extraArgs: String = "",
        var extraEnv: String = "",
    )

    private var state = State()

    override fun getState(): State = state
    override fun loadState(state: State) {
        this.state = state
    }

    companion object {
        fun getInstance(): CodepilotSettings =
            ApplicationManager.getApplication().getService(CodepilotSettings::class.java)

        /** Default collaboration modes offered in the settings dropdown. */
        val defaultModes: List<String> = listOf("agent", "plan", "chat")

        /** Coerce any string into a valid collaboration mode, falling back to "agent". */
        fun normalizeMode(raw: String?): String = when (raw) {
            "chat", "plan", "agent" -> raw
            else -> "agent"
        }
    }
}

/** Settings UI rendered under Settings → Tools → CodePilot. */
class CodepilotSettingsConfigurable : Configurable {
    private val pathField = JBTextField()
    private val modelField = JBTextField()
    private val permissionCombo = ComboBox(arrayOf("ask", "auto-edit", "yolo"))
    private val defaultModeCombo = ComboBox(CodepilotSettings.defaultModes.toTypedArray())
    private val extraArgsField = JBTextField()
    private val extraEnvArea = JTextArea(4, 40)
    private var panel: JPanel? = null

    override fun getDisplayName(): String = "CodePilot"

    override fun createComponent(): JPanel {
        val settings = CodepilotSettings.getInstance().state
        pathField.text = settings.codepilotPath
        pathField.toolTipText = "Path to the `codepilot` executable, or a name on PATH (e.g. `codepilot`, `/usr/local/bin/codepilot`)."
        modelField.text = settings.model
        modelField.toolTipText = "Default model (e.g. `claude-3-7-sonnet`, `gpt-4o`). Leave blank to inherit from core config."
        permissionCombo.selectedItem = settings.permissionMode
        permissionCombo.toolTipText = "ask = always prompt for write/exec; auto-edit = auto-approve writes; yolo = auto-approve everything."
        defaultModeCombo.selectedItem = CodepilotSettings.normalizeMode(settings.defaultMode)
        defaultModeCombo.toolTipText = "Default collaboration mode for new sessions: chat = Ask (read-only Q&A), plan = Plan (read-only exploration), agent = Agent (full autonomy)."
        extraArgsField.text = settings.extraArgs
        extraArgsField.toolTipText = "Extra CLI args passed to `codepilot` (space separated)."
        extraEnvArea.text = settings.extraEnv
        extraEnvArea.toolTipText = "Extra env vars passed to `codepilot serve` — one `KEY=VALUE` per line."

        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("`codepilot` executable:"), pathField, 1, false)
            .addLabeledComponent(JBLabel("Default model:"), modelField, 1, false)
            .addLabeledComponent(JBLabel("Permission mode:"), permissionCombo, 1, false)
            .addLabeledComponent(JBLabel("Default collaboration mode:"), defaultModeCombo, 1, false)
            .addLabeledComponent(JBLabel("Extra args:"), extraArgsField, 1, false)
            .addLabeledComponent(JBLabel("Extra env (one per line):"), wrap(extraEnvArea), 1, false)
            .addVerticalGap(8)
            .panel

        // Add a "Reset to defaults" button below.
        val resetButton = JButton("Reset to defaults").apply {
            addActionListener {
                pathField.text = "codepilot"
                modelField.text = ""
                permissionCombo.selectedItem = "ask"
                defaultModeCombo.selectedItem = "agent"
                extraArgsField.text = ""
                extraEnvArea.text = ""
            }
        }
        val south = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(Box.createHorizontalGlue())
            add(resetButton)
        }
        val root = JPanel(BorderLayout())
        root.add(panel, BorderLayout.CENTER)
        root.add(south, BorderLayout.SOUTH)
        return root
    }

    private fun wrap(inner: java.awt.Component): javax.swing.JComponent {
        // JTextArea needs scroll; keep it simple with a JPanel.
        val p = JPanel(BorderLayout())
        p.add(inner, BorderLayout.CENTER)
        return p
    }

    override fun isModified(): Boolean {
        val s = CodepilotSettings.getInstance().state
        return pathField.text != s.codepilotPath ||
            modelField.text != s.model ||
            (permissionCombo.selectedItem as? String ?: "ask") != s.permissionMode ||
            CodepilotSettings.normalizeMode(defaultModeCombo.selectedItem as? String) != CodepilotSettings.normalizeMode(s.defaultMode) ||
            extraArgsField.text != s.extraArgs ||
            extraEnvArea.text != s.extraEnv
    }

    override fun apply() {
        val s = CodepilotSettings.getInstance().state
        s.codepilotPath = pathField.text.trim().ifEmpty { "codepilot" }
        s.model = modelField.text.trim()
        s.permissionMode = (permissionCombo.selectedItem as? String ?: "ask").also {
            if (it !in setOf("ask", "auto-edit", "yolo")) permissionCombo.selectedItem = "ask"
        }
        s.defaultMode = CodepilotSettings.normalizeMode(defaultModeCombo.selectedItem as? String)
        s.extraArgs = extraArgsField.text.trim()
        s.extraEnv = extraEnvArea.text
        // Push to in-memory cache.
        CodepilotSettings.getInstance().loadState(s)
    }

    override fun reset() {
        val s = CodepilotSettings.getInstance().state
        pathField.text = s.codepilotPath
        modelField.text = s.model
        permissionCombo.selectedItem = s.permissionMode
        defaultModeCombo.selectedItem = CodepilotSettings.normalizeMode(s.defaultMode)
        extraArgsField.text = s.extraArgs
        extraEnvArea.text = s.extraEnv
    }
}