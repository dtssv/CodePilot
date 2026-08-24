package io.codepilot.harness.skill

/**
 * Decides which Skills activate for a given turn.
 *
 * Sunk from backend/codePilot-core/.../skill/SkillRouter.java. The original is
 * a Spring `@Service` that consumes `ConversationRunRequest`; this version
 * takes a [RouteRequest] data class that the IDE adapter builds directly
 * from the open editor + user message. No Spring, no ConversationRunRequest.
 *
 * Selection:
 *   1. system skills matched by [TriggerMatcher] against [WorkspaceProbe]
 *      (AGENT mode only; chat skips them)
 *   2. user skills validated by [UserSkillValidator]
 *   3. apply explicit requested/disabled lists from the request
 *   4. per-category caps (lang.primary ≤ 1, lang.aux ≤ 2, scenario ≤ 2, action ≤ 2)
 *   5. sort: source ASC, priority DESC
 */
class SkillRouter(
    private val store: SkillStore,
    private val matcher: TriggerMatcher,
    private val userValidator: UserSkillValidator,
) {
    data class RouteRequest(
        val mode: String = "AGENT",               // "AGENT" | "CHAT"
        val probe: WorkspaceProbe,
        val requested: Set<String> = emptySet(),
        val disabled: Set<String> = emptySet(),
        val userSkills: List<UserSkillInput> = emptyList(),
        val projectRootHash: String? = null,
        val allowedTools: Set<String> = emptySet(),
    )

    data class Result(val probe: WorkspaceProbe, val skills: List<ActivatedSkill>)

    fun route(req: RouteRequest): Result {
        // 1) system skills (AGENT only)
        val system = if (req.mode == "AGENT") filterSystem(req.probe, req.requested, req.disabled) else emptyList()

        // 2) user skills
        val users = userValidator.validate(req.userSkills, req.projectRootHash, req.allowedTools)

        // 3) merge + sort
        val merged = (system + users).sortedWith(
            compareBy<ActivatedSkill> { it.source }
                .thenByDescending { it.priority }
        )
        return Result(req.probe, merged)
    }

    private fun filterSystem(probe: WorkspaceProbe, requested: Set<String>, disabled: Set<String>): List<ActivatedSkill> {
        val buckets = linkedMapOf<SkillManifest.Category, MutableList<ActivatedSkill>>()
        // Convert SkillInfo → SkillManifest via parsing the markdown body's
        // frontmatter (which may carry category/priority). For simplicity, we
        // treat each .md skill as a GENERIC system skill with default priority.
        for (info in store.all()) {
            if (info.hidden) continue
            val id = info.name
            if (disabled.contains(id)) continue
            if (requested.isNotEmpty() && !requested.contains(id)) continue

            val manifest = try { SkillManifest.parse(info.content) }
                catch (_: Exception) {
                    // Not JSON-frontmatter; treat as always-on GENERIC skill
                    SkillManifest(id = id, source = "system", scope = "system",
                        systemPrompt = info.content, category = SkillManifest.Category.GENERIC)
                }
            if (!matcher.matches(manifest, probe)) continue

            val prio = if (manifest.priority == 0) 50 else manifest.priority
            buckets.getOrPut(manifest.category) { mutableListOf() }.add(
                ActivatedSkill(
                    id = id, version = manifest.version, source = "system", scope = manifest.scope,
                    priority = prio, tokens = (info.content.length + 3) / 4,
                    permissionsTools = manifest.permissions?.tools ?: emptyList(),
                    systemPrompt = manifest.systemPrompt.ifBlank { info.content },
                )
            )
        }
        val out = mutableListOf<ActivatedSkill>()
        for ((cat, list) in buckets) {
            val cap = CAP[cat] ?: 10
            val sorted = list.sortedByDescending { it.priority }
            out += if (sorted.size > cap) sorted.take(cap) else sorted
        }
        return out
    }

    companion object {
        private val CAP = mapOf(
            SkillManifest.Category.LANG_PRIMARY to 1,
            SkillManifest.Category.LANG_AUX to 2,
            SkillManifest.Category.SCENARIO to 2,
            SkillManifest.Category.ACTION to 2,
            SkillManifest.Category.GENERIC to 10,
        )
    }
}
