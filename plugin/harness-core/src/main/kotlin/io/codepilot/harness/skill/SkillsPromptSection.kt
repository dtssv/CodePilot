package io.codepilot.harness.skill

import io.codepilot.harness.context.PromptSection
import io.codepilot.harness.event.HarnessEvent

/**
 * Prompt section that injects activated skills into the system prompt.
 *
 * Implements [PromptSection] so [BudgetedComposer] includes it automatically
 * alongside [IdentitySection] / [HistorySection]. Skills are sorted by
 * priority (descending) and each is rendered as `## Skill: <name>\n\n<body>`.
 *
 * The activated skills are supplied by [SkillRouter]; this section just
 * renders them. When no skills are activated, the section is empty and the
 * composer skips it.
 */
class SkillsPromptSection(
    private val router: SkillRouter,
    private val requestProvider: () -> SkillRouter.RouteRequest,
) : PromptSection {
    override val name = "Skills"
    override val maxChars = 12_000

    override fun compose(snapshot: List<HarnessEvent>): String {
        val req = requestProvider()
        val result = router.route(req)
        if (result.skills.isEmpty()) return ""
        val sb = StringBuilder()
        for (skill in result.skills) {
            sb.append("## Skill: ").append(skill.id).append("\n\n")
            sb.append(skill.systemPrompt).append("\n\n")
        }
        return sb.toString().trim()
    }
}
