package io.codepilot.plugin.rules

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import io.codepilot.plugin.protocol.EventBus
import io.codepilot.plugin.protocol.EventTypes
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

@Service(Service.Level.PROJECT)
class RulesService(private val project: Project) {
    enum class RuleSource { PROJECT, USER, AGENTS_MD, LEGACY }

    data class Rule(
        val id: String,
        val description: String,
        val globs: List<String>,
        val alwaysApply: Boolean,
        val priority: Int,
        val body: String,
        val source: RuleSource,
    ) {
        fun toDto(): Map<String, Any?> =
            mapOf(
                "id" to id,
                "description" to description,
                "globs" to globs,
                "alwaysApply" to alwaysApply,
                "priority" to priority,
                "body" to body,
                "source" to source.name.toLowerCase(),
            )
    }

    private val current = AtomicReference<List<Rule>>(emptyList())

    fun reload(): List<Rule> {
        val base = project.basePath ?: return emptyList()
        val collected = mutableListOf<Rule>()

        val agents = Path.of(base, "AGENTS.md")
        if (Files.exists(agents)) {
            collected.add(
                Rule("AGENTS.md", "Workspace agent instructions", emptyList(), true, 0, Files.readString(agents), RuleSource.AGENTS_MD),
            )
        }

        val legacy = Path.of(base, ".codepilotrules")
        if (Files.exists(legacy)) {
            collected.add(
                Rule(".codepilotrules", "Legacy CodePilot rules", emptyList(), true, 5, Files.readString(legacy), RuleSource.LEGACY),
            )
        }

        val localLegacy = Path.of(base, ".codepilotrules.local")
        if (Files.exists(localLegacy)) {
            collected.add(
                Rule(".codepilotrules.local", "Local CodePilot rules", emptyList(), true, 6, Files.readString(localLegacy), RuleSource.LEGACY),
            )
        }

        val dir = Path.of(base, ".codepilot", "rules")
        if (Files.isDirectory(dir)) {
            Files.walk(dir).use { stream ->
                stream
                    .filter { Files.isRegularFile(it) && it.toString().endsWith(".mdc") }
                    .forEach { p ->
                        runCatching { collected.add(parseMdc(p, base, RuleSource.PROJECT)) }
                    }
            }
        }

        val userDir = Path.of(com.intellij.openapi.application.PathManager.getConfigPath(), "codepilot", "rules")
        if (Files.isDirectory(userDir)) {
            Files.walk(userDir).use { stream ->
                stream
                    .filter { Files.isRegularFile(it) && it.toString().endsWith(".mdc") }
                    .forEach { p ->
                        runCatching { collected.add(parseMdc(p, userDir.toString(), RuleSource.USER)) }
                    }
            }
        }

        val sorted = collected.sortedWith(compareBy<Rule> { it.priority }.thenBy { it.id })
        current.set(sorted)
        emit()
        return sorted
    }

    fun all(): List<Rule> = current.get().ifEmpty { reload() }

    fun activeFor(paths: List<String>): List<Rule> {
        val clean = paths.map { it.replace('\\', '/') }
        return all().filter { rule ->
            rule.alwaysApply || clean.any { path -> rule.globs.any { globMatches(path, it) } }
        }
    }

    fun renderForSystemPrompt(active: List<Rule>): String {
        if (active.isEmpty()) return ""
        return buildString {
            appendLine("## Workspace Rules (active)")
            for (rule in active) {
                appendLine("### ${rule.id} — ${rule.description}")
                appendLine(rule.body.trim())
                appendLine()
            }
        }.trim()
    }

    fun createRule(id: String, description: String, globs: List<String>, body: String): Rule {
        val base = project.basePath ?: error("project base unavailable")
        val safe = id.removePrefix("/").replace('\\', '/').ifBlank { "rule-${System.currentTimeMillis()}.mdc" }
        val path = Path.of(base, ".codepilot", "rules", if (safe.endsWith(".mdc")) safe else "$safe.mdc")
        Files.createDirectories(path.parent)
        val content = buildString {
            appendLine("---")
            appendLine("description: $description")
            appendLine("globs:")
            for (g in globs.ifEmpty { listOf("**/*") }) appendLine("  - \"$g\"")
            appendLine("alwaysApply: false")
            appendLine("priority: 10")
            appendLine("---")
            appendLine()
            appendLine(body)
        }
        Files.writeString(path, content)
        return parseMdc(path, base, RuleSource.PROJECT).also { reload() }
    }

    private fun parseMdc(path: Path, base: String, source: RuleSource): Rule {
        val raw = Files.readString(path)
        val rel = Path.of(base).relativize(path).toString().replace('\\', '/')
        val (front, body) = if (raw.startsWith("---")) {
            val end = raw.indexOf("\n---", 3)
            if (end >= 0) raw.substring(3, end).trim() to raw.substring(end + 4).trimStart()
            else "" to raw
        } else "" to raw
        val description = readScalar(front, "description") ?: rel
        val always = readScalar(front, "alwaysApply")?.equals("true", ignoreCase = true) ?: false
        val priority = readScalar(front, "priority")?.toIntOrNull() ?: 10
        val globs = readList(front, "globs")
        return Rule(rel, description, globs, always, priority, body.trim(), source)
    }

    private fun readScalar(front: String, key: String): String? =
        front.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.startsWith("$key:") }
            ?.substringAfter(":")
            ?.trim()
            ?.trim('"')

    private fun readList(front: String, key: String): List<String> {
        val lines = front.lines()
        val start = lines.indexOfFirst { it.trim() == "$key:" }
        if (start < 0) return emptyList()
        val out = mutableListOf<String>()
        for (i in start + 1 until lines.size) {
            val t = lines[i].trim()
            if (t.isEmpty()) continue
            if (!t.startsWith("-")) break
            out.add(t.removePrefix("-").trim().trim('"'))
        }
        return out
    }

    private fun globMatches(path: String, glob: String): Boolean {
        val normalized = glob.replace('\\', '/')
        val regex = normalized
            .replace(".", "\\.")
            .replace("**/", "(.*/)?")
            .replace("**", ".*")
            .replace("*", "[^/]*")
            .toRegex()
        return regex.matches(path)
    }

    private fun emit() {
        EventBus.getInstance(project).emit(
            turnId = "system",
            stepId = "rules",
            type = EventTypes.RULES_LOADED,
            payload = mapOf("rules" to all().map { it.toDto() }),
        )
    }

    companion object {
        fun getInstance(project: Project): RulesService = project.service()
    }
}
