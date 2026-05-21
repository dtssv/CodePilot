package io.codepilot.plugin.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import javax.swing.JComponent

/** Simple Settings page under Tools → CodePilot. */
class CodePilotConfigurable : Configurable {
    private val settings = CodePilotSettings.getInstance()
    private val state = settings.state.copy()
    private var panel: JComponent? = null
    // ★ Registries panel for marketplace registry management
    private val registriesPanel = RegistriesPanel()

    override fun getDisplayName(): String = "CodePilot"

    override fun createComponent(): JComponent {
        panel =
            panel {
                group("Backend") {
                    row("Base URL:") {
                        textField()
                            .bindText({ state.backendBaseUrl }, { state.backendBaseUrl = it })
                            .columns(40)
                    }
                    row("Device ID:") {
                        textField()
                            .bindText({ state.deviceId }, { state.deviceId = it })
                            .columns(40)
                            .enabled(false)
                    }
                    row("Update channel:") {
                        comboBox(listOf("stable", "beta", "dev"))
                            .bindItem({ state.updateChannel }, { state.updateChannel = it ?: "stable" })
                    }
                }
                group("Context & UX") {
                    row("Display language (Web UI):") {
                        comboBox(listOf(LocaleHelper.EN, LocaleHelper.ZH))
                            .bindItem(
                                { LocaleHelper.normalize(state.preferredLocale) },
                                { selected -> state.preferredLocale = LocaleHelper.normalize(selected) },
                            )
                    }
                    row("Context budget (tokens):") {
                        intTextField().bindIntText({ state.contextBudgetTokens }, { state.contextBudgetTokens = it })
                    }
                    row("Keep recent messages:") {
                        intTextField().bindIntText({ state.keepRecentMessages }, { state.keepRecentMessages = it })
                    }
                    row("Auto-apply low-risk patches:") {
                        checkBox("Enabled").bindSelected({ state.autoApplyLowRiskPatches }, { state.autoApplyLowRiskPatches = it })
                    }
                    row("Allow Dev SSO:") {
                        checkBox("Only when backend has dev mode enabled").bindSelected(
                            { state.allowDevSso },
                            { state.allowDevSso = it },
                        )
                    }
                }
                group("Storage") {
                    row("Session root:") {
                        textField().bindText({ state.sessionRoot }, { state.sessionRoot = it }).columns(40)
                    }
                }
                // ★ Marketplace Registries management
                group("Marketplace Registries") {
                    row {
                        cell(registriesPanel.component)
                    }
                }
            }
        return panel!!
    }

    override fun isModified(): Boolean = state != settings.state

    override fun apply() {
        settings.update { current ->
            current.backendBaseUrl = state.backendBaseUrl
            current.preferredLocale = state.preferredLocale
            current.sessionRoot = state.sessionRoot
            current.updateChannel = state.updateChannel
            current.contextBudgetTokens = state.contextBudgetTokens
            current.keepRecentMessages = state.keepRecentMessages
            current.autoApplyLowRiskPatches = state.autoApplyLowRiskPatches
            current.allowDevSso = state.allowDevSso
        }
    }

    override fun reset() {
        val current = settings.state
        state.backendBaseUrl = current.backendBaseUrl
        state.preferredLocale = current.preferredLocale
        state.sessionRoot = current.sessionRoot
        state.updateChannel = current.updateChannel
        state.contextBudgetTokens = current.contextBudgetTokens
        state.keepRecentMessages = current.keepRecentMessages
        state.autoApplyLowRiskPatches = current.autoApplyLowRiskPatches
        state.allowDevSso = current.allowDevSso
    }
}