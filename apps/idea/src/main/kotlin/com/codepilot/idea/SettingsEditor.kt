package com.codepilot.idea

import com.google.gson.Gson
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.beans.PropertyChangeListener
import java.beans.PropertyChangeSupport
import java.util.Locale
import javax.swing.JComponent

/**
 * CodePilot Settings as a real editor tab — the same interaction IntelliJ uses
 * for its "What's New" page. The settings surface only fits side-by-side layouts
 * (min-width 720px), so it must not live in the narrow chat tool window.
 */
class SettingsFileEditor(
    private val project: Project,
    private val file: VirtualFile,
) : UserDataHolderBase(), FileEditor {

    private val log = logger<SettingsFileEditor>()
    private val disposable: Disposable = Disposer.newDisposable("CodePilot settings")
    private val changes = PropertyChangeSupport(this)
    private val gson = Gson()
    private val browser = JBCefBrowser()
    private val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
    private val cwd: String = project.basePath ?: System.getProperty("user.dir") ?: "."

    // No onOpenSettings hook: the wrench inside this page must not open another tab.
    private val relay = HostRelay(
        deliver = ::deliver,
        init = { HostInit(cwd = cwd, theme = currentTheme(), locale = Locale.getDefault().toLanguageTag()) },
        onEngineError = { log.warn("codepilot engine: $it") },
    )

    private val engine = SharedEngineProcess(
        daemonCommand = { WebChatPanel.daemonCommand(CodepilotSettings.getInstance().state) },
        stdioCommand = { WebChatPanel.engineCommand(CodepilotSettings.getInstance().state) },
        workingDir = { cwd },
        env = { WebChatPanel.engineEnv(CodepilotSettings.getInstance().state) },
        engineMode = { CodepilotSettings.getInstance().state.engineMode.ifBlank { "shared" } },
        onLine = relay::fromEngine,
        onExit = relay::engineExited,
        onStderr = { log.info("[engine] $it") },
    )

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
        val html = SettingsFileEditor::class.java.getResourceAsStream(RESOURCE)
            ?.use { it.readBytes().toString(Charsets.UTF_8) }
            .orEmpty()
        browser.loadHTML(withPreset(html, currentTheme(), Locale.getDefault().toLanguageTag(), view = "settings"))
    }

    /** Jump the page to [section] (e.g. "connectors"); queued until the page is ready. */
    fun navigate(section: String?) {
        if (section != null) relay.openSettings(section)
    }

    override fun getComponent(): JComponent = browser.component

    /** The in-memory marker file this editor is registered for. */
    override fun getFile(): VirtualFile = file

    override fun getPreferredFocusedComponent(): JComponent = browser.component

    override fun getName(): String = "Settings"

    override fun getState(level: FileEditorStateLevel): FileEditorState = FileEditorState.INSTANCE

    override fun setState(state: FileEditorState) {}

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = true

    override fun addPropertyChangeListener(listener: PropertyChangeListener) = changes.addPropertyChangeListener(listener)

    override fun removePropertyChangeListener(listener: PropertyChangeListener) = changes.removePropertyChangeListener(listener)

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

    companion object {
        private const val RESOURCE = "/webview/index.html"

        /** Marker on the in-memory [VirtualFile] this editor is registered for. */
        val MARKER: Key<Boolean> = Key.create("CodePilot.settingsFile")

        private fun currentTheme(): String = if (JBColor.isBright()) "light" else "dark"
    }
}

/** Opens [SettingsFileEditor] for the in-memory marker file; no other editor may claim it. */
class SettingsFileEditorProvider : FileEditorProvider {

    override fun accept(project: Project, file: VirtualFile): Boolean =
        file.getUserData(SettingsFileEditor.MARKER) == true

    override fun createEditor(project: Project, file: VirtualFile): FileEditor = SettingsFileEditor(project, file)

    override fun getEditorTypeId(): String = "codepilot-settings"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_OTHER_EDITORS
}

/** Entry point for every "Settings" affordance (wrench, Tools menu, action). */
object SettingsEditor {

    private val log = logger<SettingsEditor>()

    /** File the [SettingsFileEditorProvider] owns, kept per project so repeats focus one tab. */
    private val FILE: Key<VirtualFile> = Key.create("CodePilot.settingsFileHandle")

    /**
     * Open (or focus) the Settings editor tab, landing on [section] when given.
     * Returns false when JCEF is unavailable — callers then fall back to the
     * native configurable.
     */
    fun open(project: Project, section: String? = null): Boolean {
        val supported = try { JBCefApp.isSupported() } catch (t: Throwable) { false }
        if (!supported) return false
        val manager = FileEditorManager.getInstance(project)
        val file = project.getUserData(FILE)?.takeIf { it.isValid } ?: createFile(project)
        return try {
            val opened = manager.openFile(file, true)
            val editor = (opened.ifEmpty { manager.getEditors(file) })
                .filterIsInstance<SettingsFileEditor>()
                .firstOrNull()
            editor?.navigate(section)
            opened.isNotEmpty()
        } catch (t: Throwable) {
            log.warn("could not open the CodePilot settings tab: ${t.message}")
            false
        }
    }

    private fun createFile(project: Project): VirtualFile {
        val file = LightVirtualFile("CodePilot Settings", PlainTextFileType.INSTANCE, "")
        file.putUserData(SettingsFileEditor.MARKER, true)
        project.putUserData(FILE, file)
        return file
    }
}
