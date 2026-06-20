package io.codepilot.core.skill;

import static org.assertj.core.api.Assertions.assertThat;

import io.codepilot.core.dto.ConversationMode;
import io.codepilot.core.skill.SkillManifest.TriggerGroup;
import io.codepilot.core.skill.SkillManifest.Triggers;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class TriggerMatcherTest {

  private final TriggerMatcher matcher = new TriggerMatcher();

  @Test
  void matchesLanguageAnyGroup() {
    SkillManifest skill =
        new SkillManifest(
            "skill.lang.java",
            "1.0.0",
            "Java",
            "system",
            "system",
            50,
            "append",
            new Triggers(null, List.of(new TriggerGroup(List.of("java"), null, null, null, null))),
            null,
            null,
            "x",
            SkillManifest.Category.LANG_PRIMARY);
    var probe = probe(Set.of("java"), Set.of(), Set.of(), "generic");
    assertThat(matcher.matches(skill, probe)).isTrue();
  }

  @Test
  void missesWhenLanguageAbsent() {
    SkillManifest skill =
        new SkillManifest(
            "skill.lang.go",
            "1.0.0",
            "Go",
            "system",
            "system",
            50,
            "append",
            new Triggers(null, List.of(new TriggerGroup(List.of("go"), null, null, null, null))),
            null,
            null,
            "x",
            SkillManifest.Category.LANG_PRIMARY);
    var probe = probe(Set.of("java"), Set.of(), Set.of(), "generic");
    assertThat(matcher.matches(skill, probe)).isFalse();
  }

  @Test
  void actionGroupMatches() {
    SkillManifest skill =
        new SkillManifest(
            "skill.action.refactor",
            "1.0.0",
            "Refactor",
            "system",
            "system",
            80,
            "append",
            new Triggers(
                null, List.of(new TriggerGroup(null, null, List.of("refactor"), null, null))),
            null,
            null,
            "x",
            SkillManifest.Category.ACTION);
    var probe = probe(Set.of(), Set.of(), Set.of(), "refactor");
    assertThat(matcher.matches(skill, probe)).isTrue();
  }

  private WorkspaceProbe.Probe probe(
      Set<String> langs, Set<String> frameworks, Set<String> files, String action) {
    return new WorkspaceProbe.Probe(
        ConversationMode.AGENT, action, langs, frameworks, files, Set.of());
  }
}
