package io.codepilot.plugin.context

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFileManager
import java.nio.charset.StandardCharsets

/**
 * Loads project-level rules from `.codepilot/rules/` directory.
 *
 * Equivalent to Cursor's .cursorrules — allows teams to define coding standards,
 * architecture constraints, and style guides that are automatically injected
 * into every AI request as system prompt segments.
 *
 * Rules are .md files with optional YAML frontmatter:
 *   ---
 *   applies_to: glob pattern    # only apply to matching files
 *   priority: 60               # higher = loaded earlier
 *   always: true               # always load regardless of file match
 *   ---
 *   (rule content in English for model consumption)
 */
@Service(Service.Level.PROJECT)
class ProjectRulesLoader(
    private val project: Project,
) {
    private val log = Logger.getInstance(ProjectRulesLoader::class.java)

    data class RuleItem(
        val id: String, // filename without extension
        val content: String, // rule text (after frontmatter)
        val appliesTo: String?, // glob pattern for file matching
        val priority: Int, // higher = loaded first
        val always: Boolean, // always load?
        val path: String, // relative path to rule file
    )

    /**
     * Load all rules applicable to the current context.
     * @param currentFilePath optional — if set, only rules with matching `applies_to` or `always=true` are returned
     * @return sorted list of rules (highest priority first)
     */
    fun loadRules(currentFilePath: String? = null): List<RuleItem> {
        val projectBase = project.basePath ?: return emptyList()
        val rulesDir =
            VirtualFileManager
                .getInstance()
                .findFileByUrl("file://$projectBase/.codepilot/rules") ?: return emptyList()

        if (!rulesDir.isDirectory) return emptyList()

        val rules = mutableListOf<RuleItem>()

        for (file in rulesDir.children) {
            if (file.isDirectory) continue
            if (!file.name.endsWith(".md") && !file.name.endsWith(".txt")) continue

            try {
                val raw = String(file.contentsToByteArray(), StandardCharsets.UTF_8)
                val (frontmatter, content) = parseFrontmatter(raw)

                val appliesTo = frontmatter["applies_to"] ?: frontmatter["appliesTo"]
                val priority = frontmatter["priority"]?.toIntOrNull() ?: 50
                val always = frontmatter["always"]?.lowercase() == "true"

                // Filter: if currentFilePath is specified, only include matching rules
                if (currentFilePath != null && !always && appliesTo != null) {
                    if (!matchGlob(currentFilePath, appliesTo)) continue
                }

                val id = file.nameWithoutExtension
                val relativePath = ".codepilot/rules/${file.name}"

                rules.add(
                    RuleItem(
                        id = id,
                        content = content.trim(),
                        appliesTo = appliesTo,
                        priority = priority,
                        always = always,
                        path = relativePath,
                    ),
                )
            } catch (e: Exception) {
                log.warn("Failed to load rule file: ${file.name}", e)
            }
        }

        return rules.sortedByDescending { it.priority }
    }

    /**
     * Format rules for injection into system prompt.
     */
    fun formatForPrompt(rules: List<RuleItem>): String {
        if (rules.isEmpty()) return ""
        val sb = StringBuilder()
        sb.appendLine("[PROJECT_RULES_BEGIN]")
        for (rule in rules) {
            sb.appendLine("// Rule: ${rule.id} (priority=${rule.priority})")
            sb.appendLine(rule.content)
            sb.appendLine()
        }
        sb.appendLine("[PROJECT_RULES_END]")
        return sb.toString()
    }

    private fun parseFrontmatter(raw: String): Pair<Map<String, String>, String> {
        val trimmed = raw.trimStart()
        if (!trimmed.startsWith("---")) return emptyMap<String, String>() to raw

        val endIndex = trimmed.indexOf("---", 3)
        if (endIndex == -1) return emptyMap<String, String>() to raw

        val frontmatterBlock = trimmed.substring(3, endIndex).trim()
        val content = trimmed.substring(endIndex + 3)

        val map = mutableMapOf<String, String>()
        for (line in frontmatterBlock.lines()) {
            val colonIdx = line.indexOf(':')
            if (colonIdx > 0) {
                val key = line.substring(0, colonIdx).trim()
                val value =
                    line
                        .substring(colonIdx + 1)
                        .trim()
                        .removeSurrounding("\"")
                        .removeSurrounding("'")
                map[key] = value
            }
        }
        return map to content
    }

    private fun matchGlob(
        filePath: String,
        glob: String,
    ): Boolean {
        val regex =
            glob
                .replace(".", "\\.")
                .replace("**", "§§")
                .replace("*", "[^/]*")
                .replace("§§", ".*")
        return filePath.matches(Regex(regex))
    }

    companion object {
        @JvmStatic
        fun getInstance(project: Project): ProjectRulesLoader = project.service()
    }
}
