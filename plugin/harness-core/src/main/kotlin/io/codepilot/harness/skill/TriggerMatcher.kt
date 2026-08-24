package io.codepilot.harness.skill

import java.nio.file.FileSystems
import java.nio.file.Path
import java.nio.file.PathMatcher
import java.util.concurrent.ConcurrentHashMap

/**
 * Decides whether a Skill's triggers fire for a given [WorkspaceProbe].
 *
 * Sunk from backend/codePilot-core/.../skill/TriggerMatcher.java. The original
 * is a Spring `@Component`; this is a plain Kotlin class.
 *
 * Semantics (unchanged):
 *   - triggers.all[*]  — every group MUST match (AND of groups)
 *   - triggers.any[*]  — any single group is enough (OR of groups)
 *   - within a group, every populated dimension (language, framework, action,
 *     fileGlob, keywords) MUST overlap with the probe — empty dimensions are
 *     ignored.
 *   - no triggers configured → always-on (e.g. patching guidance)
 */
class TriggerMatcher {

    private val globCache = ConcurrentHashMap<String, PathMatcher>()

    fun matches(skill: SkillManifest, probe: WorkspaceProbe): Boolean {
        val t = skill.triggers ?: return true // no triggers = always-on
        if (t.all.isNotEmpty()) {
            for (g in t.all) if (!matchesGroup(g, probe)) return false
        }
        if (t.any.isNotEmpty()) {
            var any = false
            for (g in t.any) if (matchesGroup(g, probe)) { any = true; break }
            if (!any) return false
        }
        return true
    }

    private fun matchesGroup(g: SkillManifest.TriggerGroup, probe: WorkspaceProbe): Boolean {
        if (!intersectIfPresent(g.language, probe.languages)) return false
        if (!intersectIfPresent(g.framework, probe.frameworks)) return false
        if (!intersectIfPresent(g.action, setOfNotNull(probe.action))) return false
        if (!intersectIfPresent(g.keywords, probe.keywords)) return false
        if (!matchesAnyGlob(g.fileGlob, probe.filePaths)) return false
        return true
    }

    private fun intersectIfPresent(required: List<String>, available: Set<String>): Boolean {
        if (required.isEmpty()) return true
        for (r in required) {
            if (r.isBlank()) continue
            if (available.contains(r.lowercase())) return true
        }
        return false
    }

    private fun matchesAnyGlob(globs: List<String>, paths: Set<String>): Boolean {
        if (globs.isEmpty()) return true
        if (paths.isEmpty()) return false
        for (glob in globs) {
            if (glob.isBlank()) continue
            val syntaxAndPattern = ensurePrefix(glob)
            val matcher = try {
                globCache.computeIfAbsent(syntaxAndPattern) {
                    FileSystems.getDefault().getPathMatcher(it)
                }
            } catch (_: IllegalArgumentException) { continue }
                catch (_: UnsupportedOperationException) { continue }
            for (p in paths) {
                try {
                    val path = Path.of(p)
                    if (matcher.matches(path) || matcher.matches(path.fileName)) return true
                } catch (_: RuntimeException) { /* malformed path; skip */ }
            }
        }
        return false
    }

    private fun ensurePrefix(pattern: String): String =
        if (pattern.startsWith("glob:") || pattern.startsWith("regex:")) pattern
        else "glob:$pattern"
}
