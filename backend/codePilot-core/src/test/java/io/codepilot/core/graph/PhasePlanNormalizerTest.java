package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PhasePlanNormalizerTest {

  @Test
  void expandsSinglePhaseToMatchUserSteps() {
    List<Map<String, Object>> userSteps =
        List.of(
            Map.of("id", "s1", "title", "Create doc dir"),
            Map.of("id", "s2", "title", "Write design doc"),
            Map.of("id", "s3", "title", "Write prompts"));
    List<Map<String, Object>> phases = List.of(Map.of("id", "p1", "intent", "code-change"));

    var normalized = PhasePlanNormalizer.normalize(userSteps, phases);

    assertThat(normalized).hasSize(3);
    assertThat(normalized.get(0).get("id")).isEqualTo("p1");
    assertThat(normalized.get(1).get("id")).isEqualTo("p2");
    assertThat(normalized.get(0).get("userStepId")).isEqualTo("s1");
    assertThat(normalized.get(2).get("userStepIndex")).isEqualTo(2);
  }

  @Test
  void keepsPlannerPhaseCountWhenFewerThanUserSteps() {
    List<Map<String, Object>> userSteps =
        List.of(
            Map.of("id", "s1", "title", "A"),
            Map.of("id", "s2", "title", "B"),
            Map.of("id", "s3", "title", "C"),
            Map.of("id", "s4", "title", "D"),
            Map.of("id", "s5", "title", "E"));
    List<Map<String, Object>> phases =
        List.of(
            Map.of("id", "p1", "intent", "code-change"),
            Map.of("id", "p2", "intent", "code-change"),
            Map.of("id", "p3", "intent", "code-change"));

    var normalized = PhasePlanNormalizer.normalize(userSteps, phases);

    assertThat(normalized).hasSize(3);
    assertThat(normalized.get(2).get("id")).isEqualTo("p3");
  }

  @Test
  void mergesMultipleDeliverableWriteSteps() {
    List<Map<String, Object>> userSteps =
        List.of(
            Map.of("id", "s1", "title", "List sources", "intent", "discover"),
            Map.of("id", "s2", "title", "Read sources", "intent", "inspect"),
            Map.of("id", "s3", "title", "Analyze", "intent", "analyze"),
            Map.of("id", "s4", "title", "Write report A", "intent", "synthesize"),
            Map.of("id", "s5", "title", "Write report B", "intent", "synthesize"));
    List<Map<String, Object>> phases =
        List.of(
            Map.of("id", "p1", "intent", "discover"),
            Map.of("id", "p2", "intent", "inspect"),
            Map.of("id", "p3", "intent", "analyze"),
            Map.of("id", "p4", "intent", "synthesize"),
            Map.of("id", "p5", "intent", "synthesize"));

    var normalized = PhasePlanNormalizer.normalizePlan(userSteps, phases);

    assertThat(normalized.steps()).hasSize(4);
    assertThat(normalized.phases()).hasSize(4);
    assertThat(normalized.phases().get(3).get("intent")).isEqualTo("synthesize");
  }

  @Test
  void keepsOneToOnePhases() {
    List<Map<String, Object>> userSteps =
        List.of(Map.of("id", "s1", "title", "A"), Map.of("id", "s2", "title", "B"));
    List<Map<String, Object>> phases =
        List.of(Map.of("id", "p1", "intent", "code-change"), Map.of("id", "p2", "intent", "code-change"));

    var normalized = PhasePlanNormalizer.normalize(userSteps, phases);

    assertThat(normalized).hasSize(2);
    assertThat(normalized.get(1).get("userStepId")).isEqualTo("s2");
  }
}
