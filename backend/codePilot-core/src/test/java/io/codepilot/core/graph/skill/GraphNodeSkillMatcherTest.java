package io.codepilot.core.graph.skill;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.cloud.ai.graph.OverAllState;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.skill.SkillManifest;
import io.codepilot.core.skill.SystemSkillLoader;
import io.codepilot.core.skill.TriggerMatcher;
import io.codepilot.core.skill.WorkspaceProbe;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class GraphNodeSkillMatcherTest {

    @Test
    void matchesUserSkillWhenBodyPresent() {
        var skill =
                new SkillManifest(
                        "skill.lang.java",
                        "1.0.0",
                        "Java",
                        "system",
                        "system",
                        50,
                        "append",
                        new SkillManifest.Triggers(
                                List.of(new SkillManifest.TriggerGroup(List.of("java"), null, null, null, null)),
                                null),
                        null,
                        null,
                        "Use Java conventions.",
                        SkillManifest.Category.LANG_PRIMARY);

        var loader = new StubSystemSkillLoader(List.of(skill));
        var matcher = new StubTriggerMatcher(true);

        var matcherBean = new GraphNodeSkillMatcher(loader, matcher);
        var state = new OverAllState();
        state.registerKeyAndStrategy("input", new com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy());
        state.registerKeyAndStrategy("projectMeta", new com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy());
        state.registerKeyAndStrategy("mode", new com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy());
        state.registerKeyAndStrategy("userSkillRefs", new com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy());
        state.registerKeyAndStrategy("userSkillBodies", new com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy());
        state.registerKeyAndStrategy("skillsConfig", new com.alibaba.cloud.ai.graph.state.strategy.ReplaceStrategy());
        state.input(Map.of(
                "input", "fix the service",
                "projectMeta", "Languages: Java\n",
                "mode", "AGENT",
                "userSkillRefs", List.of(),
                "userSkillBodies", Map.of()));

        var hits = matcherBean.match(state, GraphSkillNode.GENERATE);
        assertThat(hits).anyMatch(s -> "skill.lang.java".equals(s.id()));
    }

    /** Simple stub that returns a fixed list of skill manifests. */
    static class StubSystemSkillLoader extends SystemSkillLoader {

        private final List<SkillManifest> skills;

        StubSystemSkillLoader(List<SkillManifest> skills) {
            this.skills = skills;
        }

        @Override
        public List<SkillManifest> all() {
            return skills;
        }
    }

    /** Simple stub that always returns the configured match result. */
    static class StubTriggerMatcher extends TriggerMatcher {

        private final boolean result;

        StubTriggerMatcher(boolean result) {
            this.result = result;
        }

        @Override
        public boolean matches(SkillManifest skill, WorkspaceProbe.Probe probe) {
            return result;
        }
    }
}