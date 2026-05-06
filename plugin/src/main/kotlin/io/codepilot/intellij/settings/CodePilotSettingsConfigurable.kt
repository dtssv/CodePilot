package io.codepilot.intellij.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.ui.components.JBTextField
import com.intellij.ui.layout.panel
import javax.swing.JComponent
import javax.swing.JCheckBox

/**
 * Settings UI for CodePilot plugin.
 */
class CodePilotSettingsConfigurable : Configurable {

    private val settings = CodePilotSettings.getInstance()

    private lateinit var serverUrlField: JBTextField
    private lateinit var defaultModelField: JBTextField
    private lateinit var defaultModeField: JBTextField
    private lateinit var maxStepsField: JBTextField
    private lateinit var contextBudgetField: JBTextField
    private lateinit var autoApplyLowRiskCheck: JCheckBox
    private lateinit var autoApplyMediumRiskCheck: JCheckBox
    private lateinit var ragEnabledCheck: JCheckBox
    private lateinit var telemetryEnabledCheck: JCheckBox
    private lateinit var updateChannelField: JBTextField

    override fun getDisplayName(): String = "CodePilot"

    override fun createComponent(): JComponent {
        return panel {
            group("Server") {
                row("Server URL:") {
                    serverUrlField = JBTextField(settings.serverUrl, 40)
                    serverUrlField()
                }
            }
            group("Model") {
                row("Default Model ID:") {
                    defaultModelField = JBTextField(settings.defaultModelId, 30)
                    defaultModelField()
                }
                row("Default Mode (chat/agent):") {
                    defaultModeField = JBTextField(settings.defaultMode, 10)
                    defaultModeField()
                }
                row("Max Agent Steps:") {
                    maxStepsField = JBTextField(settings.maxAgentSteps.toString(), 6)
                    maxStepsField()
                }
                row("Context Budget (tokens):") {
                    contextBudgetField = JBTextField(settings.contextBudgetTokens.toString(), 10)
                    contextBudgetField()
                }
            }
            group("Patches") {
                row("") {
                    autoApplyLowRiskCheck = JCheckBox("Auto-apply low-risk patches", settings.autoApplyLowRisk)
                    autoApplyLowRiskCheck()
                }
                row("") {
                    autoApplyMediumRiskCheck = JCheckBox("Auto-apply medium-risk patches", settings.autoApplyMediumRisk)
                    autoApplyMediumRiskCheck()
                }
            }
            group("Features") {
                row("") {
                    ragEnabledCheck = JCheckBox("Enable RAG (code indexing)", settings.ragEnabled)
                    ragEnabledCheck()
                }
                row("") {
                    telemetryEnabledCheck = JCheckBox("Enable telemetry", settings.telemetryEnabled)
                    telemetryEnabledCheck()
                }
            }
            group("Updates") {
                row("Update Channel (stable/beta/dev):") {
                    updateChannelField = JBTextField(settings.updateChannel, 10)
                    updateChannelField()
                }
            }
        }
    }

    override fun isModified(): Boolean {
        return serverUrlField.text != settings.serverUrl ||
            defaultModelField.text != settings.defaultModelId ||
            defaultModeField.text != settings.defaultMode ||
            maxStepsField.text != settings.maxAgentSteps.toString() ||
            contextBudgetField.text != settings.contextBudgetTokens.toString() ||
            autoApplyLowRiskCheck.isSelected != settings.autoApplyLowRisk ||
            autoApplyMediumRiskCheck.isSelected != settings.autoApplyMediumRisk ||
            ragEnabledCheck.isSelected != settings.ragEnabled ||
            telemetryEnabledCheck.isSelected != settings.telemetryEnabled ||
            updateChannelField.text != settings.updateChannel
    }

    override fun apply() {
        settings.serverUrl = serverUrlField.text.trim()
        settings.defaultModelId = defaultModelField.text.trim()
        settings.defaultMode = defaultModeField.text.trim()
        settings.maxAgentSteps = maxStepsField.text.toIntOrNull() ?: 25
        settings.contextBudgetTokens = contextBudgetField.text.toIntOrNull() ?: 100000
        settings.autoApplyLowRisk = autoApplyLowRiskCheck.isSelected
        settings.autoApplyMediumRisk = autoApplyMediumRiskCheck.isSelected
        settings.ragEnabled = ragEnabledCheck.isSelected
        settings.telemetryEnabled = telemetryEnabledCheck.isSelected
        settings.updateChannel = updateChannelField.text.trim()
    }

    override fun reset() {
        serverUrlField.text = settings.serverUrl
        defaultModelField.text = settings.defaultModelId
        defaultModeField.text = settings.defaultMode
        maxStepsField.text = settings.maxAgentSteps.toString()
        contextBudgetField.text = settings.contextBudgetTokens.toString()
        autoApplyLowRiskCheck.isSelected = settings.autoApplyLowRisk
        autoApplyMediumRiskCheck.isSelected = settings.autoApplyMediumRisk
        ragEnabledCheck.isSelected = settings.ragEnabled
        telemetryEnabledCheck.isSelected = settings.telemetryEnabled
        updateChannelField.text = settings.updateChannel
    }
}