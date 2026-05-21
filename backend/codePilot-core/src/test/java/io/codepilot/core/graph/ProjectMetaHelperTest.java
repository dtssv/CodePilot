package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ProjectMetaHelperTest {

  private static final String SAMPLE_META =
      """
      Project languages: C/C++
      Root directory entries (3):
        lc/
        main.cpp
        leetcode42.cpp
      """;

  @Test
  void parseRootEntries_extractsFilesAndDirs() {
    var entries = ProjectMetaHelper.parseRootEntries(SAMPLE_META);
    assertEquals(3, entries.size());
    assertEquals("dir", entries.get(0).get("type"));
    assertEquals("lc", entries.get(0).get("name"));
    assertEquals("file", entries.get(1).get("type"));
    assertEquals("main.cpp", entries.get(1).get("name"));
  }

  @Test
  void seedFromProjectMeta_populatesGatheredAndBlocksRootList() {
    Map<String, Object> initial = new HashMap<>();
    initial.put("projectMeta", SAMPLE_META);
    initial.put("gatheredInfo", new HashMap<>());

    ProjectMetaHelper.seedFromProjectMeta(initial);

    @SuppressWarnings("unchecked")
    Map<String, Object> gathered = (Map<String, Object>) initial.get("gatheredInfo");
    assertTrue(PhaseGoalHelper.gatheredHasSuccessfulList(gathered));
    @SuppressWarnings("unchecked")
    List<String> attempted = (List<String>) initial.get("toolApproachesAttempted");
    assertTrue(attempted.contains("fs.list:."));
  }

  @Test
  void tryAbsorbRootListing_satisfiesDiscoverOnBlockedRepeat() {
    var state =
        new OverAllState(
            Map.of(
                "projectMeta",
                SAMPLE_META,
                "userPlan",
                Map.of(
                    "steps",
                    List.of(
                        Map.of(
                            "id",
                            "s1",
                            "title",
                            "Discover files",
                            "status",
                            "in_progress",
                            "intent",
                            "discover"))),
                "phaseCursor",
                "p1",
                "phases",
                List.of(Map.of("id", "p1", "title", "Discover", "intent", "discover"))));
    Map<String, Object> gathered = new HashMap<>();
    Map<String, Object> updates = new HashMap<>();

    assertTrue(ProjectMetaHelper.tryAbsorbRootListing(state, gathered, updates));
    assertTrue(PhaseGoalHelper.currentStepGoalSatisfied(state, gathered));
  }

  @Test
  void tryAbsorbRootListing_noOpWithoutMeta() {
    var state =
        new OverAllState(
            Map.of(
                "phaseCursor",
                "p1",
                "phases",
                List.of(Map.of("id", "p1", "intent", "discover"))));
    Map<String, Object> updates = new HashMap<>();
    assertFalse(ProjectMetaHelper.tryAbsorbRootListing(state, new HashMap<>(), updates));
  }
}
