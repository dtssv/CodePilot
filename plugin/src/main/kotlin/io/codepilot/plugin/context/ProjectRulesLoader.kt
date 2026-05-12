package io.codepilot.plugin.context

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

/**
 * .codepilotrules Project Rules Loader.
 *
 * Inspired by Cursor's .cursorrules — a single file in the project root
 * that contains project-specific instructions automatically included in
 * every conversation's system prompt.
 *
 * Format: Plain text / Markdown with optional section headers.
 * Location: {project.root}/.codepilotrules
 *
 * Features:
 * - Auto-detect and load on project open
 * - File watcher: reload on changes (VFS BulkFileListener)
 * - Cached content with fast read path
 * - Optional: .codepilotrules.local for personal overrides (git-ignored)
 */
object ProjectRulesLoader {

    private const val RULES_FILE = ".codepilotrules"
    private const val LOCAL_RULES_FILE = ".codepilotrules.local"

    // Project basePath → combined rules content
    private val rulesCache = ConcurrentHashMap<String, String>()
    // Project basePath → last modified timestamp
    private val lastModified = ConcurrentHashMap<String, Long>()

    /**
     * Get the combined project rules content for the given project.
     * Loads from .codepilotrules + .codepilotrules.local (if exists).
     * Results are cached and refreshed on file changes.
     */
    fun getRules(project: Project): String? {
        val basePath = project.basePath ?: return null
        rulesCache[basePath]?.let { return it }

        return loadRules(basePath).also {
            if (it != null) rulesCache[basePath] = it
        }
    }

    /**
     * Force-reload rules from disk (called on file change events).
     */
    fun reloadRules(project: Project) {
        val basePath = project.basePath ?: return
        rulesCache.remove(basePath)
        loadRules(basePath)?.let { rulesCache[basePath] = it }
    }

    /**
     * Check if a .codepilotrules file exists for the project.
     */
    fun hasRules(project: Project): Boolean {
        val basePath = project.basePath ?: return false
        return Files.exists(Path.of(basePath, RULES_FILE))
    }

    /**
     * Build the system prompt fragment from project rules.
     * Returns a formatted string ready to append to the system prompt,
     * or null if no rules exist.
     */
    fun buildRulesPromptFragment(project: Project): String? {
        val rules = getRules(project) ?: return null
        return """
            |# Project Rules (.codepilotrules)
            |The following rules are defined by the project and must be followed in all responses:
            |
            |$rules
            |
            |End of project rules. Apply these rules to all code generation, editing, and analysis.
        """.trimMargin()
    }

    /**
     * Create a default .codepilotrules template in the project root.
     */
    fun createDefaultRules(project: Project) {
        val basePath = project.basePath ?: return
        val rulesPath = Path.of(basePath, RULES_FILE)
        if (Files.exists(rulesPath)) return

        val template = """
            |# CodePilot Project Rules
            |
            |## Code Style
            |- Use descriptive variable names
            |- Add comments for complex logic
            |- Follow existing code patterns in the project
            |
            |## Architecture
            |- Follow the existing project structure
            |- Keep modules decoupled
            |
            |## Testing
            |- Write unit tests for new functions
            |- Test edge cases
            |
            |## Custom Rules
            |- Add your project-specific rules here
        """.trimMargin()

        Files.writeString(rulesPath, template)

        // Refresh VFS
        ApplicationManager.getApplication().invokeLater {
            LocalFileSystem.getInstance().refreshAndFindFileByPath(rulesPath.toString())
        }
    }

    // ─── Internal ──────────────────────────────────────────────────────

    private fun loadRules(basePath: String): String? {
        val parts = mutableListOf<String>()

        // Load main rules
        val mainPath = Path.of(basePath, RULES_FILE)
        if (Files.exists(mainPath)) {
            val content = Files.readString(mainPath).trim()
            if (content.isNotEmpty()) parts.add(content)
        }

        // Load local overrides (personal, git-ignored)
        val localPath = Path.of(basePath, LOCAL_RULES_FILE)
        if (Files.exists(localPath)) {
            val content = Files.readString(localPath).trim()
            if (content.isNotEmpty()) {
                parts.add("\n## Local Overrides (.codepilotrules.local)\n$content")
            }
        }

        return if (parts.isNotEmpty()) parts.joinToString("\n\n") else null
    }

    /**
     * VFS file change listener for .codepilotrules files.
     * Registers in plugin startup to auto-reload on changes.
     */
    class RulesFileChangeListener(private val project: Project) : BulkFileListener {
        override fun after(events: MutableList<out VFileEvent>) {
            for (event in events) {
                val fileName = event.file?.name
                if (fileName == RULES_FILE || fileName == LOCAL_RULES_FILE) {
                    val eventPath = event.file?.path
                    val basePath = project.basePath
                    if (eventPath != null && basePath != null && eventPath.startsWith(basePath)) {
                        reloadRules(project)
                    }
                }
            }
        }
    }
}