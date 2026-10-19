package com.codepilot.idea

import com.google.gson.Gson
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.EnvironmentUtil
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.io.File
import java.util.Locale
import javax.swing.JComponent

/**
 * Chat tool window content: the shared CodePilot web UI (the same app as the
 * web client, desktop agent and VSCode view) in a JCEF browser, relayed to a
 * per-project `codepilot serve` process through [HostRelay].
 */
class WebChatPanel private constructor(
    private val project: Project,
    private val html: String,
) : ChatHost {

    private val log = logger<WebChatPanel>()
    private val disposable: Disposable = Disposer.newDisposable("CodePilot chat")
    private val gson = Gson()
    private val browser = JBCefBrowser()
    private val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val cwd: String = project.basePath ?: System.getProperty("user.dir") ?: "."

    private val relay = HostRelay(
        deliver = ::deliver,
        init = { HostInit(cwd = cwd, theme = currentTheme(), locale = Locale.getDefault().language) },
        openFile = ::openFile,
        onEngineError = { log.warn("codepilot engine: $it") },
    )

    private val engine = EngineProcess(
        command = { engineCommand(CodepilotSettings.getInstance().state) },
        workingDir = { cwd },
        env = { engineEnv(CodepilotSettings.getInstance().state) },
        onLine = relay::fromEngine,
        onExit = relay::engineExited,
        onStderr = { log.info("[engine] $it") },
    )

    override val component: JComponent get() = browser.component

    init {
        relay.engine = engine
        Disposer.register(disposable, query)
        Disposer.register(disposable, browser)
        query.addHandler { msg ->
            relay.fromPage(msg)
            null
        }
        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadStart(b: CefBrowser?, frame: CefFrame?, transitionType: org.cef.network.CefRequest.TransitionType?) {
                if (frame?.isMain == true) relay.pageGone()
            }

            override fun onLoadEnd(b: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                if (frame?.isMain != true) return
 // The page queues its messages until this channel exists.
                run("window.__codepilotHostPost = function (m) { ${query.inject("m")} };")
            }
        }, browser.cefBrowser)
        ApplicationManager.getApplication().messageBus.connect(disposable)
            .subscribe(LafManagerListener.TOPIC, LafManagerListener { relay.theme(currentTheme()) })
        browser.loadHTML(withPreset(html, currentTheme()))
    }

    override fun sendEditorContext(filePath: String, language: String?, snippet: String) {
        val rel = project.basePath?.let { base -> File(filePath).relativeToOrNull(File(base))?.path } ?: filePath
        val lang = language?.lowercase().orEmpty()
        relay.prompt("Explain this code.\n\n```$lang\n// @$rel\n$snippet\n```", send = false)
    }

    override fun dispose() {
        engine.stop()
        Disposer.dispose(disposable)
    }

    private fun deliver(json: String) {
        run("window.__codepilotReceive && window.__codepilotReceive(${gson.toJson(json)});")
    }

    private fun run(js: String) {
        browser.cefBrowser.executeJavaScript(js, browser.cefBrowser.url, 0)
    }

    private fun openFile(path: String, line: Int?) {
        val abs = if (File(path).isAbsolute) path else File(cwd, path).path
        ApplicationManager.getApplication().invokeLater {
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(abs) ?: return@invokeLater
            OpenFileDescriptor(project, vf, ((line ?: 1) - 1).coerceAtLeast(0), 0).navigate(true)
        }
    }

    companion object {
        private const val RESOURCE = "/webview/index.html"

 /** The JCEF panel, or null when JCEF or the bundled UI is unavailable. */
        fun createOrNull(project: Project): WebChatPanel? {
            if (!JBCefApp.isSupported()) return null
            val html = WebChatPanel::class.java.getResourceAsStream(RESOURCE)?.use { it.readBytes().toString(Charsets.UTF_8) }
                ?: return null
            return WebChatPanel(project, html)
        }

        private fun currentTheme(): String = if (JBColor.isBright()) "light" else "dark"

        internal fun engineCommand(s: CodepilotSettings.State): List<String> {
            val cmd = CodepilotService.buildCommand(s).toMutableList()
 // IDEs launched from the Dock do not inherit the login shell PATH.
            cmd[0] = resolveExecutable(cmd[0], EnvironmentUtil.getValue("PATH"))
            return cmd
        }

        internal fun engineEnv(s: CodepilotSettings.State): Map<String, String> =
            EnvironmentUtil.getEnvironmentMap() + CodepilotService.parseEnv(s.extraEnv) + mapOf(
                "CODEPILOT_CLIENT" to "idea",
            )
    }
}
