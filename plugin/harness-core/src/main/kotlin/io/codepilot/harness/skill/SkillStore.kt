package io.codepilot.harness.skill

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.readText
import kotlin.streams.toList

/**
 * Loads and stores skills from disk (.codepilot/skills/ and bundled dirs).
 *
 * Sunk from backend/codePilot-core/.../skill/SystemSkillLoader.java. The
 * original is a Spring `@Component` reading from a configured skills root;
 * here we accept a list of [SkillSource] directories and scan them on demand.
 *
 * Each [SkillSource] is a (root, source, scope) triple:
 *   - root:       directory containing *.md skill files
 *   - source:      "system" (bundled) or "user" (project-local)
 *   - scope:       "system" | "project" | "global"
 */
class SkillStore(
    private val sources: List<SkillSource>,
) {
    data class SkillSource(
        val root: Path,
        val source: String = "system",
        val scope: String = "system",
    )

    @Volatile private var cache: List<SkillInfo>? = null

    /** Load all skills from all sources. Cached; call [reload] to invalidate. */
    fun all(): List<SkillInfo> {
        cache?.let { return it }
        val out = mutableListOf<SkillInfo>()
        for (src in sources) out.addAll(loadFromSource(src))
        cache = out
        return out
    }

    fun byId(id: String): SkillInfo? = all().firstOrNull { it.name == id }

    fun reload(): List<SkillInfo> {
        cache = null
        return all()
    }

    private fun loadFromSource(src: SkillSource): List<SkillInfo> {
        if (!src.root.exists() || !src.root.isDirectory()) return emptyList()
        return Files.walk(src.root).use { stream ->
            stream.filter { it.toString().endsWith(".md") }
                .filter { it.fileName.toString().equals("SKILL.md", ignoreCase = true) || it.toString().endsWith(".md") }
                .toList()
                .mapNotNull { f ->
                    runCatching {
                        val content = f.readText()
                        val rel = src.root.relativize(f).toString()
                        SkillInfo.parse(content, rel)
                    }.getOrNull()
                }
        }
    }
}
