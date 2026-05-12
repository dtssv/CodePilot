package io.codepilot.plugin.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.Project
import io.codepilot.plugin.settings.CodePilotSettings

/**
 * Toggle agent mode on/off (Ctrl+I).
 *
 * Switches between Chat mode (single-turn, no tools) and Agent mode
 * (multi-turn with tool execution, plan-first loop). The mode is
 * persisted in CodePilotSettings and communicated to the WebUI.
 */
class ToggleAgentAction : AnAction("Toggle Agent Mode", "Toggle between Chat and Agent mode", null) {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        val settings = CodePilotSettings.getInstance()

        // Toggle mode: chat → agent, agent → chat
        val currentMode = settings.state.conversationMode
        val newMode = if (currentMode == "agent") "chat" else "agent"
        settings.state.conversationMode = newMode

        // Notify WebUI of mode change
        val panel = io.codepilot.plugin.toolwindow.CefChatPanelRegistry.getInstance(project)
        panel?.dispatchToWeb("mode_changed", mapOf("mode" to newMode))
    }

    override fun update(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT)
        e.presentation.isEnabled = project != null
        // Show current mode in action text
        val settings = CodePilotSettings.getInstance()
        val mode = settings.state.conversationMode ?: "chat"
        e.presentation.text = if (mode == "agent") "Switch to Chat Mode" else "Switch to Agent Mode"
    }
}