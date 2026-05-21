package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PhaseOutcomeHelperTest {

  @Test
  void clearsFailureFlagWhenAnalyzeHasSourceReadsDespiteEarlierFailure() {
    Map<String, Object> gathered = new HashMap<>();
    gathered.put(
        "bad",
        Map.of("kind", "fs.read", "ok", false, "errorMessage", "timeout"));
    gathered.put(
        "good",
        Map.of(
            "kind",
            "fs.read",
            "ok",
            true,
            "result",
            Map.of("path", "leetcode42.cpp", "content", "code")));

    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put("phases", List.of(Map.of("id", "p3", "intent", "analyze")));
    data.put("phaseToolsHadFailure", true);
    var state = new OverAllState(data);

    var updates = new HashMap<String, Object>();
    PhaseOutcomeHelper.recordGatheredOutcome(state, gathered, updates);

    assertThat(updates.get("phaseToolsHadFailure")).isEqualTo(false);
  }
}
