package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PhasePlanNormalizerTest {

  @Test
  void expandsSinglePhaseToMatchUserSteps() {
    var userSteps =
        List.of(
            Map.of("id", "s1", "title", "Create doc dir"),
            Map.of("id", "s2", "title", "Write design doc"),
            Map.of("id", "s3", "title", "Write prompts"));
    var phases = List.of(Map.of("id", "p1", "intent", "code-change"));

    var normalized = PhasePlanNormalizer.normalize(userSteps, phases);

    assertThat(normalized).hasSize(3);
    assertThat(normalized.get(0).get("id")).isEqualTo("p1");
    assertThat(normalized.get(1).get("id")).isEqualTo("p2");
    assertThat(normalized.get(0).get("userStepId")).isEqualTo("s1");
    assertThat(normalized.get(2).get("userStepIndex")).isEqualTo(2);
  }

  @Test
  void expandsPartialPhasesToMatchFiveSteps() {
    var userSteps =
        List.of(
            Map.of("id", "s1", "title", "A"),
            Map.of("id", "s2", "title", "B"),
            Map.of("id", "s3", "title", "C"),
            Map.of("id", "s4", "title", "D"),
            Map.of("id", "s5", "title", "E"));
    var phases =
        List.of(
            Map.of("id", "p1", "intent", "code-change"),
            Map.of("id", "p2", "intent", "code-change"),
            Map.of("id", "p3", "intent", "code-change"));

    var normalized = PhasePlanNormalizer.normalize(userSteps, phases);

    assertThat(normalized).hasSize(5);
    assertThat(normalized.get(4).get("userStepId")).isEqualTo("s5");
  }

  @Test
  void keepsOneToOnePhases() {
    var userSteps =
        List.of(Map.of("id", "s1", "title", "A"), Map.of("id", "s2", "title", "B"));
    var phases =
        List.of(Map.of("id", "p1", "intent", "code-change"), Map.of("id", "p2", "intent", "code-change"));

    var normalized = PhasePlanNormalizer.normalize(userSteps, phases);

    assertThat(normalized).hasSize(2);
    assertThat(normalized.get(1).get("userStepId")).isEqualTo("s2");
  }
}
