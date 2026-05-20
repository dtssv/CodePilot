package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ToolApproachTrackerTest {

  @Test
  void emptyFsListIsUnsatisfactory() {
    Map<String, Object> entry =
        Map.of(
            "kind",
            "fs.list",
            "ok",
            true,
            "result",
            Map.of("path", ".", "entries", List.of()));

    assertThat(ToolApproachTracker.isUnsatisfactory("fs.list", entry)).isTrue();
  }

  @Test
  void nonEmptyFsListIsSatisfactory() {
    Map<String, Object> entry =
        Map.of(
            "kind",
            "fs.list",
            "ok",
            true,
            "result",
            Map.of(
                "path",
                "src",
                "entries",
                List.of(Map.of("name", "Main.java", "type", "file"))));

    assertThat(ToolApproachTracker.isUnsatisfactory("fs.list", entry)).isFalse();
  }

  @Test
  void fingerprintNormalizesBlankPath() {
    assertThat(ToolApproachTracker.fingerprint("fs.list", Map.of()))
        .isEqualTo("fs.list:.");
    assertThat(ToolApproachTracker.fingerprint("fs.list", Map.of("path", "leetcode")))
        .isEqualTo("fs.list:leetcode");
  }

  @Test
  void recordsThreeDistinctUnsatisfactoryApproaches() {
    var updates = new HashMap<String, Object>();
    OverAllState state = new OverAllState(Map.of("toolApproachHistory", List.of()));

    recordList(state, updates, "a", ".");
    state = new OverAllState(updates);

    recordList(state, updates, "b", "src");
    state = new OverAllState(updates);

    recordList(state, updates, "c", "leetcode");

    assertThat(updates.get("toolApproachExhausted")).isEqualTo(true);
    assertThat((List<?>) updates.get("toolApproachHistory")).hasSize(3);
  }

  @Test
  void duplicatePathDoesNotAddSecondHistoryEntry() {
    var updates = new HashMap<String, Object>();
    OverAllState state =
        new OverAllState(Map.of("toolApproachHistory", List.of("fs.list:.")));

    recordList(state, updates, "a", ".");

    assertThat(updates.containsKey("toolApproachExhausted")).isFalse();
    assertThat(updates.containsKey("toolApproachHistory")).isFalse();
  }

  private static void recordList(
      OverAllState state, Map<String, Object> updates, String id, String path) {
    ToolApproachTracker.recordFromRequests(
        state,
        List.of(Map.of("id", id, "kind", "fs.list", "args", Map.of("path", path))),
        Map.of(
            id,
            Map.of(
                "kind",
                "fs.list",
                "ok",
                true,
                "result",
                Map.of("path", path, "entries", List.of()))),
        updates);
  }
}
