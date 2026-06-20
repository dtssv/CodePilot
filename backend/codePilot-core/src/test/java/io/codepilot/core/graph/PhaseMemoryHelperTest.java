package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PhaseMemoryHelperTest {

  @Test
  void queryTagsFromPhaseUsesTagsAndHintsOnly() {
    var phase =
        Map.of(
            "id", "p1",
            "tags", List.of("user_table"),
            "memoryHints", List.of("UserEntity"));
    assertThat(PhaseMemoryHelper.queryTagsFromPhase(phase))
        .containsExactly("user_table", "UserEntity");
  }

  @Test
  void productRequirementsStructured() {
    Map<String, Object> phase = new java.util.LinkedHashMap<>();
    phase.put(
        "requiredProducts",
        List.of(
            Map.<String, Object>of(
                "product", "entity",
                "patterns", List.of("*Entity.java"),
                "searchPaths", List.of("src/entity/"))));
    var reqs = PhaseMemoryHelper.productRequirements(phase);
    assertThat(reqs).hasSize(1);
    assertThat(reqs.get(0).product()).isEqualTo("entity");
    assertThat(reqs.get(0).patterns()).contains("*Entity.java");
  }

  @Test
  void skipVerifyFromBudget() {
    Map<String, Object> phase =
        Map.of("budget", Map.<String, Object>of("skipVerify", true));
    assertThat(PhaseMemoryHelper.skipVerifyForPhase(phase)).isTrue();
  }
}
