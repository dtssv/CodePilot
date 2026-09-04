package com.codepilot.idea

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import java.util.concurrent.atomic.AtomicReference

/**
 * Hosts the singleton [CodepilotClient].
 *
 * - [Application] is created on first use and shut down on IDE exit (via [Disposable.dispose]).
 * - [ProjectService] gives project-scoped lifecycle: on `projectClosing` we *don't* shut the client
 *   down — the agent talks to it across multiple project windows — but we do flush any
 *   per-project subscriptions.
 */
class CodepilotService private constructor() {

    @Service(Service.Level.APP)
    class Application : Disposable {

        private val log = logger<Application>()
        private val clientRef = AtomicReference<CodepilotClient?>(null)

        /** Returns a shared client, starting the process lazily. */
        @Synchronized
        fun client(): CodepilotClient? {
            clientRef.get()?.let { return it }
            val settings = CodepilotSettings.getInstance().state
            val cwd = System.getProperty("user.dir") ?: "."
            val cmd = buildCommand(settings)
            val env = parseEnv(settings.extraEnv)
            return try {
                val client = CodepilotClient(command = cmd, workingDir = cwd, envOverrides = env)
                client.start()
                client.initialize(cwd, settings.permissionMode)
                clientRef.set(client)
                log.info("Started ${cmd.first()} on cwd=$cwd")
                client
            } catch (t: Throwable) {
                log.warn("Failed to start codepilot client: ${t.message}", t)
                null
            }
        }

        override fun dispose() {
            clientRef.getAndSet(null)?.shutdown()
        }
    }

    @Service(Service.Level.PROJECT)
    class ProjectService(val project: Project) : Disposable {

        private val log = logger<ProjectService>()

        init {
            // When the user closes the project, do *not* shut the singleton client — other projects
            // might still be using it. We just log so it's visible in audit.
            ProjectManager.getInstance().addProjectManagerListener(
                object : ProjectManagerListener {
                    override fun projectClosing(closing: Project) {
                        if (closing === project) {
                            log.info("Project ${closing.name} closing — leaving codepilot client alive.")
                        }
                    }
                },
            )
        }

        fun client(): CodepilotClient? = ApplicationManager.getApplication()
            .getService(Application::class.java)?.client()

        fun newSessionId(): String? {
            val settings = CodepilotSettings.getInstance().state
            // Use basePath directly; works in 2024.1.
            val projectCwd: String? = project.basePath
            val mode = CodepilotSettings.normalizeMode(settings.defaultMode)
            return try {
                client()?.newSession(
                    cwd = projectCwd,
                    model = settings.model.ifBlank { null },
                    agentMode = mode,
                )
            } catch (t: Throwable) {
                log.warn("newSession failed: ${t.message}", t)
                null
            }
        }

        override fun dispose() {
            // No-op; App service is disposed on IDE exit.
        }
    }

    companion object {
        fun getInstance(project: Project): ProjectService =
            project.getService(ProjectService::class.java)

        fun getInstance(): Application =
            ApplicationManager.getApplication().getService(Application::class.java)

        // ---------- helpers ----------

        internal fun buildCommand(s: CodepilotSettings.State): List<String> {
            val parts = mutableListOf(s.codepilotPath, "serve")
            // Allow user-provided args to override / append.
            if (s.extraArgs.isNotBlank()) parts += s.extraArgs.split(Regex("\\s+")).filter { it.isNotBlank() }
            return parts
        }

        internal fun parseEnv(text: String): Map<String, String> {
            val out = mutableMapOf<String, String>()
            text.lineSequence().forEach { line ->
                val trimmed = line.trim()
                if (trimmed.isEmpty() || trimmed.startsWith("#")) return@forEach
                val idx = trimmed.indexOf('=')
                if (idx > 0) {
                    out[trimmed.substring(0, idx).trim()] = trimmed.substring(idx + 1).trim()
                }
            }
            return out
        }
    }
}