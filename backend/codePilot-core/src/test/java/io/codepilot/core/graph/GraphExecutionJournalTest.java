package io.codepilot.core.graph;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class GraphExecutionJournalTest {

  @Test
  void recordsPhaseAndInjectsHistory() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "sh1",
        Map.of(
            "kind",
            "shell.exec",
            "ok",
            false,
            "errorMessage",
            "cmake: command not found",
            "result",
            Map.of("command", "cmake .", "stderr", "cmake: not found")));

    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put("gatheredInfo", gathered);
    data.put(
        "userPlan",
        Map.of("steps", List.of(Map.of("title", "Compile", "status", "in_progress", "intent", "compile"))));
    data.put("phases", List.of(Map.of("id", "p3", "intent", "compile")));
    var state = new OverAllState(data);

    var updates = new HashMap<String, Object>();
    GraphExecutionJournal.recordPhaseBoundary(state, updates, "p3", "commit", "ok", gathered);

    assertTrue(updates.containsKey(GraphExecutionJournal.STATE_KEY));
    var restored = new OverAllState(updates);
    String directive = GraphExecutionJournal.promptDirective(restored);
    assertFalse(directive.isBlank());
    assertTrue(directive.contains("EXECUTION HISTORY"));
    assertTrue(directive.contains("cmake"));
  }
}
