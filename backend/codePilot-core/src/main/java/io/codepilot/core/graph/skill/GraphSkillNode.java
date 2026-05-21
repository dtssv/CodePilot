package io.codepilot.core.graph.skill;

import java.util.Set;

/** Graph nodes where matched Skills may be injected into LLM prompts. */
public enum GraphSkillNode {
    INTAKE(Set.of()),
    PLANNING(Set.of("plan", "planning", "design", "规划", "计划", "设计")),
    GENERATE(Set.of("implement", "generate", "code", "build", "实现", "编写", "生成")),
    REPAIR(Set.of("fix", "repair", "debug", "error", "修复", "错误", "调试"));

    private final Set<String> actionHints;

    GraphSkillNode(Set<String> actionHints) {
        this.actionHints = actionHints;
    }

    public Set<String> actionHints() {
        return actionHints;
    }
}
