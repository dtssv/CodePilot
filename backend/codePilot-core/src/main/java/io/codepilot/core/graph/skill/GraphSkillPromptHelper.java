package io.codepilot.core.graph.skill;

import io.codepilot.core.skill.ActivatedSkill;
import java.util.List;

/** Formats activated Skills for injection into graph LLM prompts. */
public final class GraphSkillPromptHelper {

    private GraphSkillPromptHelper() {}

    public static String buildSection(List<ActivatedSkill> skills) {
        if (skills == null || skills.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder("\n[ACTIVE SKILLS — follow for this step only]\n");
        for (ActivatedSkill skill : skills) {
            String body = skill.systemPrompt();
            if (body == null || body.isBlank()) continue;
            sb.append("[SKILL_BEGIN id=").append(skill.id()).append(" source=").append(skill.source())
                    .append("]\n");
            sb.append(body.trim()).append("\n");
            sb.append("[SKILL_END]\n");
        }
        return sb.toString();
    }
}
