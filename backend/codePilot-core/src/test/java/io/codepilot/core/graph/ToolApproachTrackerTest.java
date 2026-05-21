package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.cloud.ai.graph.OverAllState;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import java.util.ArrayList;
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
  void successfulListIsRecordedForDedup() {
    var updates = new HashMap<String, Object>();
    OverAllState state = new OverAllState(Map.of());

    recordSuccessfulList(state, updates, "list_root", ".");

    assertThat(ToolApproachTracker.attemptedFingerprints(new OverAllState(updates)))
        .containsExactly("fs.list:.");
    assertThat(ToolApproachTracker.isExhausted(new OverAllState(updates))).isFalse();
    assertThat(ToolApproachTracker.history(new OverAllState(updates))).isEmpty();
  }

  @Test
  void parallelFailedReadsInSameDirCountAsOneApproach() throws Exception {
    ObjectMapper mapper = new ObjectMapper();
    ArrayNode calls = mapper.createArrayNode();
    Map<String, Object> gathered = new HashMap<>();
    String[] paths = {
      "pkg/a.cpp", "pkg/b.cpp", "pkg/c.cpp", "pkg/d.cpp"
    };
    for (int i = 0; i < paths.length; i++) {
      String id = "read" + i;
      calls.add(
          mapper
              .createObjectNode()
              .put("id", id)
              .put("name", "fs.read")
              .set("args", mapper.createObjectNode().put("path", paths[i])));
      gathered.put(
          "direct-" + id,
          Map.of(
              "kind",
              "fs.read",
              "ok",
              false,
              "errorMessage",
              "file does not exist: " + paths[i],
              "result",
              Map.of("path", paths[i])));
    }

    List<JsonNode> callList = new ArrayList<>();
    calls.forEach(callList::add);

    var updates = new HashMap<String, Object>();
    OverAllState state = new OverAllState(Map.of());
    ToolApproachTracker.recordFromDirectCalls(state, callList, gathered, updates);

    @SuppressWarnings("unchecked")
    List<String> history = (List<String>) updates.get("toolApproachHistory");
    assertThat(history).hasSize(1);
    assertThat(history.get(0)).contains("pkg");
    assertThat(history.get(0)).contains("parallel failures");
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

  private static void recordSuccessfulList(
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
                Map.of(
                    "path",
                    path,
                    "entries",
                    List.of(Map.of("name", "leetcode42.cpp", "type", "file"))))),
        updates);
  }
}
