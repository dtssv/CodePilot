package io.codepilot.plugin.auth

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import io.codepilot.plugin.settings.CodePilotSettings
import java.awt.BorderLayout
import java.awt.Desktop
import java.net.URI
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Modal login dialog. Displays the login methods enabled by the backend (`/v1/auth/methods`) on
 * separate tabs, lets the user pick a flow, and persists the resulting token via [AuthService].
 */
class LoginDialog(
    project: Project?,
) : DialogWrapper(project, true) {
    private val tabs = JBTabbedPane()
    private val statusLabel = JBLabel(" ")
    private val ssoTokenField = JBPasswordField()
    private val devTokenField = JBPasswordField()
    private val devUserField = JBTextField()
    private val devTenantField = JBTextField()
    private val devDeviceField = JBTextField(CodePilotSettings.getInstance().state.deviceId)
    private var oidcFlow: LoginService.OidcFlow? = null
    private val oidcStatus = JBLabel(" ")
    private val verifyLink = JButton("Open verification URL")

    init {
        title = "Sign in to CodePilot"
        init()
        loadMethods()
    }

    override fun createCenterPanel(): JComponent {
        tabs.addTab("OIDC (browser)", buildOidcTab())
        tabs.addTab("SSO bridge token", buildBridgeTab())
        tabs.addTab("Dev login", buildDevTab())
        val outer = JPanel(BorderLayout(0, 6))
        outer.add(tabs, BorderLayout.CENTER)
        outer.add(statusLabel, BorderLayout.SOUTH)
        return outer
    }

    private fun loadMethods() {
        statusLabel.text = "Discovering enabled login methods…"
        LoginService.getInstance().discover().whenComplete { m, err ->
            ApplicationManager.getApplication().invokeLater {
                if (err != null) {
                    statusLabel.text = "Could not reach backend: ${err.message}"
                } else {
                    tabs.setEnabledAt(0, m.oidc && m.deviceFlow)
                    tabs.setEnabledAt(1, m.hmacBridge)
                    tabs.setEnabledAt(2, m.dev && CodePilotSettings.getInstance().state.allowDevSso)
                    statusLabel.text = "Pick a login method enabled by your backend."
                }
            }
        }
    }

    private fun buildOidcTab(): JComponent {
        verifyLink.isEnabled = false
        verifyLink.addActionListener { tryOpenBrowser(oidcFlow?.code?.verificationUriComplete) }
        return panel {
            row { label("Click 'Start' to open your browser. The IDE will sign in once you finish there.") }
            row {
                button("Start") { startOidc() }
                button("Cancel polling") {
                    oidcFlow?.cancel()
                    oidcStatus.text = "Cancelled."
                }
                cell(verifyLink)
            }
            row { cell(oidcStatus) }
        }
    }

    private fun startOidc() {
        oidcStatus.text = "Requesting device code…"
        verifyLink.isEnabled = false
        val flow = LoginService.getInstance().startOidc()
        oidcFlow = flow
        flow.asFuture().whenComplete { _, err ->
            ApplicationManager.getApplication().invokeLater {
                if (err == null) {
                    oidcStatus.text = "Signed in successfully."
                    close(OK_EXIT_CODE)
                } else {
                    oidcStatus.text = "Failed: ${err.message}"
                }
            }
        }
        // Poll the local OidcFlow object: the URL becomes available a moment after startup.
        ApplicationManager.getApplication().executeOnPooledThread {
            for (i in 0 until 50) {
                Thread.sleep(100)
                val code = flow.code ?: continue
                ApplicationManager.getApplication().invokeLater {
                    oidcStatus.text =
                        "Open: ${code.verificationUriComplete ?: code.verificationUri} (code ${code.userCode})"
                    verifyLink.isEnabled = code.verificationUriComplete != null
                }
                break
            }
        }
    }

    private fun buildBridgeTab(): JComponent =
        panel {
            row { label("Paste the bootstrap token issued by your SSO Adapter.") }
            row("SSO token:") { cell(ssoTokenField).columns(40) }
            row {
                button("Sign in") { runBridgeLogin() }
            }
        }

    private fun runBridgeLogin() {
        val raw = String(ssoTokenField.password).trim()
        if (raw.isEmpty()) {
            statusLabel.text = "Token must not be empty."
            return
        }
        statusLabel.text = "Signing in…"
        LoginService.getInstance().bridgeLogin(raw).whenComplete { _, err ->
            ApplicationManager.getApplication().invokeLater {
                if (err == null) {
                    statusLabel.text = "Signed in."
                    close(OK_EXIT_CODE)
                } else {
                    statusLabel.text = "Login failed: ${err.message}"
                }
            }
        }
    }

    private fun buildDevTab(): JComponent =
        panel {
            row {
                label(
                    "Dev mode is for local demos only. The backend must explicitly enable it.",
                )
            }
            row("Dev shared token:") { cell(devTokenField).columns(30) }
            row("User id:") { cell(devUserField).columns(30) }
            row("Tenant id:") { cell(devTenantField).columns(30) }
            row("Device id:") { cell(devDeviceField).columns(30) }
            row { button("Sign in (dev)") { runDevLogin() } }
        }

    private fun runDevLogin() {
        val token = String(devTokenField.password).trim()
        val user = devUserField.text.trim()
        val tenant = devTenantField.text.trim()
        val device = devDeviceField.text.trim().ifEmpty { CodePilotSettings.getInstance().state.deviceId }
        if (token.isEmpty() || user.isEmpty() || tenant.isEmpty()) {
            statusLabel.text = "Fill all fields."
            return
        }
        statusLabel.text = "Signing in (dev)…"
        LoginService.getInstance().devLogin(token, user, tenant, device).whenComplete { _, err ->
            ApplicationManager.getApplication().invokeLater {
                if (err == null) {
                    statusLabel.text = "Signed in."
                    close(OK_EXIT_CODE)
                } else {
                    statusLabel.text = "Login failed: ${err.message}"
                }
            }
        }
    }

    private fun tryOpenBrowser(url: String?) {
        if (url.isNullOrBlank()) return
        runCatching { Desktop.getDesktop().browse(URI.create(url)) }
            .onFailure { Messages.showInfoMessage("Open this URL manually:\n$url", "CodePilot") }
    }
}
