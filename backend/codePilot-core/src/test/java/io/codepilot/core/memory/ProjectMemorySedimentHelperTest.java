package io.codepilot.core.memory;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ProjectMemorySedimentHelperTest {

  @Test
  void promotesProtectedCandidatesToLongTerm() {
    List<Map<String, Object>> maps =
        List.of(
            Map.<String, Object>of(
                "id", "mem-1",
                "layer", "SHORT_TERM",
                "protection", "PROTECTED",
                "type", "DECISION",
                "summary", "Use Postgres",
                "tags", List.of("db")));
    var out = ProjectMemorySedimentHelper.forProjectPersistence(maps);
    assertThat(out).hasSize(1);
    assertThat(out.get(0).layer()).isEqualTo(MemoryLayer.LONG_TERM);
    assertThat(out.get(0).summary()).contains("Postgres");
  }

  @Test
  void skipsVolatileCandidates() {
    List<Map<String, Object>> maps =
        List.of(
            Map.<String, Object>of(
                "id", "mem-v",
                "layer", "SHORT_TERM",
                "protection", "VOLATILE",
                "type", "FACT",
                "summary", "noise"));
    assertThat(ProjectMemorySedimentHelper.forProjectPersistence(maps)).isEmpty();
  }
}
