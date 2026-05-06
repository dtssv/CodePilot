package io.codepilot.intellij.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Persistent settings for CodePilot plugin.
 *
 * API keys are stored in JetBrains PasswordSafe, not here.
 */
@State(name = "CodePilotSettings", storages = [Storage("codepilot.xml")])
class CodePilotSettings : PersistentStateComponent<CodePilotSettings> {

    /** Backend server URL */
    var serverUrl: String = "https://api.codepilot.dev"

    /** JWT token (cached, retrieved from PasswordSafe on startup) */
    var jwtToken: String = ""

    /** Device ID (generated on first run) */
    var deviceId: String = ""

    /** Default model ID */
    var defaultModelId: String = "codePilot-default"

    /** Default mode: "chat" or "agent" */
    var defaultMode: String = "chat"

    /** Max agent steps */
    var maxAgentSteps: Int = 25

    /** Context budget in tokens */
    var contextBudgetTokens: Int = 100000

    /** Auto-apply low-risk patches */
    var autoApplyLowRisk: Boolean = false

    /** Auto-apply medium-risk patches (requires confirmation by default) */
    var autoApplyMediumRisk: Boolean = false

    /** Shell command blacklist (regex patterns) */
    var shellBlacklist: String = "rm\\s+-rf\\s+/|mkfs|shutdown|format\\s+[A-Z]:|del\\s+/f\\s+/s\\s+/q\\s+C:"

    /** File path blacklist (regex patterns) */
    var pathBlacklist: String = "\\.git/|\\.idea/|node_modules/|\\.env|\\.pem$|\\.p12$|\\.key$"

    /** Update channel: stable, beta, dev */
    var updateChannel: String = "stable"

    /** RAG enabled */
    var ragEnabled: Boolean = true

    /** Telemetry enabled */
    var telemetryEnabled: Boolean = true

    override fun getState(): CodePilotSettings = this

    override fun loadState(state: CodePilotSettings) {
        XmlSerializerUtil.copyBean(state, this)
    }

    companion object {
        fun getInstance(): CodePilotSettings =
            ApplicationManager.getApplication().getService(CodePilotSettings::class.java)
    }
}