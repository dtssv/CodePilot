package io.codepilot.plugin.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBTabbedPane
import io.codepilot.plugin.i18n.CodePilotBundle
import io.codepilot.plugin.marketplace.MarketplacePanel
import io.codepilot.plugin.mcp.McpPanel
import javax.swing.JComponent

/**
 * Swing-only integrations surface when the WebUI (JCEF) chat is unavailable.
 * When JCEF is active, use the in-app **集成** tab (same Skills + MCP flows) so there is only one UX.
 */
class IntegrationsToolPanel(
    project: Project,
) {
    val component: JComponent =
        JBTabbedPane().apply {
            addTab(CodePilotBundle.message("toolwindow.integrations.skills"), MarketplacePanel(project).component)
            addTab(CodePilotBundle.message("toolwindow.integrations.mcp"), McpPanel(project).component)
        }
}
