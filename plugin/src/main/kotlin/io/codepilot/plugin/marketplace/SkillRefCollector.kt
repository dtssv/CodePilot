package io.codepilot.plugin.marketplace

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.security.MessageDigest
import java.util.HexFormat

/**
 * Builds {@code userSkillRefs} (metadata) and {@code userSkillBodies} (prompt text)
 * for the conversation API.
 *
 * **Execution model:** Skills never run as processes — they supply prompt fragments.
 * This collector only ships **full** `systemPrompt` bodies for skills that pass a
 * **coarse** workspace/language filter so bandwidth stays bounded; the server’s
 * `GraphNodeSkillMatcher` re-evaluates triggers **per graph node** and drops skills
 * without a matching body entry.
 */
object SkillRefCollector {

    data class Payload(
        val refs: List<Map<String, Any?>>,
        val bodies: Map<String, String>,
    )

    fun collect(project: Project, projectRootHash: String): Payload {
        val store = LocalMarketplaceStore.getInstance()
        val projectLanguages = detectLanguages(project)
        val refs = mutableListOf<Map<String, Any?>>()
        val bodies = linkedMapOf<String, String>()

        for (active in store.activeSkills(project)) {
            val yaml = store.readSkillBody(active)
            val parsed = SkillYamlParser.parse(yaml)
            if (!coarseMatch(parsed, active.entry.id, projectLanguages)) continue

            val key = "${active.entry.id}@${active.entry.version}"
            val sha = active.entry.sha256.ifBlank { sha256(yaml) }
            refs.add(
                mapOf(
                    "id" to active.entry.id,
                    "version" to active.entry.version,
                    "source" to "user",
                    "scope" to active.scope,
                    "projectRootHash" to projectRootHash,
                    "sha256" to sha,
                    "triggers" to SkillYamlParser.triggersPayload(parsed),
                    "category" to (parsed.category ?: "GENERIC"),
                    "priority" to parsed.priority,
                ),
            )
            if (parsed.systemPrompt.isNotBlank()) {
                bodies[key] = parsed.systemPrompt
            }
        }
        return Payload(refs, bodies)
    }

    private fun coarseMatch(parsed: SkillYamlParser.Parsed, skillId: String, languages: Set<String>): Boolean {
        if (parsed.triggerLanguages.isEmpty() && parsed.triggerGlobs.isEmpty()) {
            return true
        }
        val langs = parsed.triggerLanguages.map { it.lowercase() }.toSet()
        if (langs.any { languages.contains(it) }) return true
        val id = skillId.lowercase()
        if (languages.contains("java") && id.contains("java")) return true
        if (languages.contains("kotlin") && id.contains("kotlin")) return true
        if (languages.contains("python") && id.contains("python")) return true
        if ((languages.contains("typescript") || languages.contains("javascript")) &&
            (id.contains("ts") || id.contains("js"))
        ) {
            return true
        }
        if (languages.contains("go") && id.contains("go")) return true
        return false
    }

    private fun detectLanguages(project: Project): Set<String> {
        val base = project.basePath ?: return emptySet()
        val root = LocalFileSystem.getInstance().refreshAndFindFileByPath(base) ?: return emptySet()
        val exts = mutableSetOf<String>()
        for (child in root.children.take(200)) {
            if (!child.isDirectory) child.extension?.lowercase()?.let { exts.add(it) }
        }
        val out = mutableSetOf<String>()
        if ("java" in exts) out.add("java")
        if ("kt" in exts || "kts" in exts) out.add("kotlin")
        if ("py" in exts) out.add("python")
        if ("ts" in exts || "tsx" in exts) out.add("typescript")
        if ("js" in exts || "jsx" in exts) out.add("javascript")
        if ("go" in exts) out.add("go")
        return out
    }

    private fun sha256(text: String): String =
        HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)),
        )

    fun projectRootHash(project: Project): String {
        val base = project.basePath ?: project.name
        return sha256(base)
    }
}
