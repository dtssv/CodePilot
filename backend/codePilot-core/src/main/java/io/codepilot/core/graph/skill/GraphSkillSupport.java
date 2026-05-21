package io.codepilot.core.graph.skill;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.graph.GraphSseHelper;
import io.codepilot.core.skill.ActivatedSkill;
import io.codepilot.core.sse.SseEvents;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Activates Skills for a graph node and emits {@code skills_activated} SSE. */
@Component
public class GraphSkillSupport {

    private final GraphNodeSkillMatcher matcher;

    public GraphSkillSupport(GraphNodeSkillMatcher matcher) {
        this.matcher = matcher;
    }

    public SkillActivation activate(
            OverAllState state, GraphSkillNode node, Map<String, Object> updates) {
        List<ActivatedSkill> skills = matcher.match(state, node);
        if (!skills.isEmpty()) {
            updates.put(
                    "activeSkillIds",
                    skills.stream().map(ActivatedSkill::id).toList());
            GraphSseHelper.emitEvent(
                    state,
                    SseEvents.SKILLS_ACTIVATED,
                    Map.of(
                            "node",
                            node.name(),
                            "items",
                            skills.stream()
                                    .map(
                                            a ->
                                                    Map.of(
                                                            "id",
                                                            a.id(),
                                                            "version",
                                                            a.version(),
                                                            "source",
                                                            a.source(),
                                                            "scope",
                                                            a.scope(),
                                                            "priority",
                                                            a.priority(),
                                                            "tokens",
                                                            a.tokens()))
                                    .toList()));
        }
        return new SkillActivation(skills, GraphSkillPromptHelper.buildSection(skills));
    }

    public record SkillActivation(List<ActivatedSkill> skills, String promptSection) {}
}
