package io.codepilot.plugin.marketplace

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.DefaultListModel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JTextArea

/**
 * Consent confirmation dialog shown before installing a third-party Skill/MCP package.
 *
 * Displays:
 * - Package name, version, and description
 * - Signature verification status (signed by whom)
 * - Required permissions (tools, network, filesystem access)
 * - License information
 * - Risk level indicator
 *
 * The user must explicitly check "I understand and agree" to proceed.
 * This implements the consent step (Step 4) of the 8-step install flow.
 */
class PackageConsentDialog(
    project: Project?,
    private val packageName: String,
    private val version: String,
    private val description: String,
    private val permissions: Map<String, Any?>,
    private val signatureSubject: String?,
    private val signatureValid: Boolean,
    private val license: String?,
    private val riskLevel: RiskLevel,
) : DialogWrapper(project) {

    enum class RiskLevel { LOW, MEDIUM, HIGH }

    private val agreeCheckBox = JBCheckBox("I understand the risks and agree to install this package").apply {
        isSelected = false
    }

    init {
        title = "Install Package: $packageName"
        setOKButtonText("Install")
        init()
        // Disable OK until user checks agreement
        isOKActionEnabled = false
        agreeCheckBox.addActionListener { isOKActionEnabled = agreeCheckBox.isSelected }
    }

    override fun createCenterPanel(): JPanel {
        val panel = JPanel(BorderLayout(10, 10))
        panel.preferredSize = Dimension(520, 420)

        // ─── Header ───
        val headerPanel = JPanel(BorderLayout())
        val riskIcon = when (riskLevel) {
            RiskLevel.LOW -> "🟢"
            RiskLevel.MEDIUM -> "🟡"
            RiskLevel.HIGH -> "🔴"
        }
        val riskText = when (riskLevel) {
            RiskLevel.LOW -> "Low Risk"
            RiskLevel.MEDIUM -> "Medium Risk — review permissions carefully"
            RiskLevel.HIGH -> "High Risk — unsigned or dangerous permissions"
        }
        headerPanel.add(JBLabel("<html><b>$riskIcon $riskText</b></html>"), BorderLayout.NORTH)
        panel.add(headerPanel, BorderLayout.NORTH)

        // ─── Details form ───
        val formBuilder = FormBuilder.createFormBuilder()
            .addLabeledComponent("Package:", JBLabel("<html><b>$packageName</b> v$version</html>"))
            .addLabeledComponent("Description:", createWrappedLabel(description))

        // Signature status
        val sigText = if (signatureValid && signatureSubject != null) {
            "<html><span style='color:green'>✓ Signed by: <b>$signatureSubject</b></span></html>"
        } else {
            "<html><span style='color:red'>✗ Not signed or signature invalid</span></html>"
        }
        formBuilder.addLabeledComponent("Signature:", JBLabel(sigText))

        // License
        if (license != null) {
            formBuilder.addLabeledComponent("License:", JBLabel(license))
        }

        // ─── Permissions section ───
        val permPanel = buildPermissionsPanel()
        formBuilder.addLabeledComponent("Permissions:", permPanel)

        // ─── Agreement checkbox ───
        formBuilder.addSeparator()
        formBuilder.addComponent(agreeCheckBox)

        panel.add(formBuilder.panel, BorderLayout.CENTER)
        return panel
    }

    private fun buildPermissionsPanel(): JBScrollPane {
        val model = DefaultListModel<String>()

        @Suppress("UNCHECKED_CAST")
        val tools = permissions["tools"] as? List<String>
        if (tools != null && tools.isNotEmpty()) {
            model.addElement("── Tools ──")
            for (tool in tools) {
                val risk = if (tool in DANGEROUS_TOOLS) " ⚠️" else ""
                model.addElement("  • $tool$risk")
            }
        }

        val networkAccess = permissions["network"] as? Boolean
        if (networkAccess == true) {
            model.addElement("── Network ──")
            val domains = permissions["networkDomains"] as? List<String>
            if (domains != null) {
                for (domain in domains) {
                    model.addElement("  • $domain")
                }
            } else {
                model.addElement("  • Unrestricted network access ⚠️")
            }
        }

        val fsWrite = permissions["fsWrite"] as? Boolean
        if (fsWrite == true) {
            model.addElement("── Filesystem ──")
            val paths = permissions["fsPaths"] as? List<String>
            if (paths != null) {
                for (path in paths) {
                    model.addElement("  • Write: $path")
                }
            } else {
                model.addElement("  • Unrestricted filesystem write ⚠️")
            }
        }

        val envAccess = permissions["env"] as? Boolean
        if (envAccess == true) {
            model.addElement("── Environment ──")
            model.addElement("  • Can read environment variables ⚠️")
        }

        if (model.isEmpty) {
            model.addElement("No special permissions required")
        }

        val list = JList(model)
        list.visibleRowCount = 8
        return JBScrollPane(list)
    }

    private fun createWrappedLabel(text: String): JBLabel {
        return JBLabel("<html><div style='width:360px'>$text</div></html>")
    }

    companion object {
        /** Tools that are considered dangerous and require extra scrutiny. */
        internal val DANGEROUS_TOOLS = setOf(
            "shell.exec", "fs.delete", "fs.write", "fs.replace",
            "ide.applyPatch", "network.fetch",
        )
    }
}