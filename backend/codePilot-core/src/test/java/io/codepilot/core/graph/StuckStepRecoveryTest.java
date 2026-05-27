package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.cloud.ai.graph.OverAllState;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class StuckStepRecoveryTest {

  @Test
  void shouldNotReAskAfterStuckQuestionAnswered() {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put("phaseFailureRetries", 5);
    data.put("phaseToolsHadFailure", true);
    data.put(
        "taskLedger",
        Map.of("notes", List.of("answered:" + StuckStepRecovery.questionId("p3") + "=alternative")));
    var state = new OverAllState(data);

    assertThat(StuckStepRecovery.wasStuckQuestionAnswered(state)).isTrue();
    assertThat(StuckStepRecovery.shouldEscalateToAskUser(state)).isFalse();
  }

  @Test
  void consumeStuckAnswerClearsFailureCounters() {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put("phaseFailureRetries", 4);
    data.put("phaseToolsHadFailure", true);
    data.put(
        "taskLedger",
        Map.of("notes", List.of("answered:" + StuckStepRecovery.questionId("p3") + "=alternative")));
    var state = new OverAllState(data);

    Map<String, Object> updates = StuckStepRecovery.consumeStuckAnswerIfPresent(state);

    assertThat(updates.get("phaseFailureRetries")).isEqualTo(0);
    assertThat(updates.get("phaseToolsHadFailure")).isEqualTo(false);
  }

  @Test
  void skipOptionMarksAnalysisOutput() {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put(
        "taskLedger",
        Map.of("notes", List.of("answered:" + StuckStepRecovery.questionId("p3") + "=skip")));
    var state = new OverAllState(data);

    Map<String, Object> updates = StuckStepRecovery.consumeStuckAnswerIfPresent(state);

    assertThat(updates.get("phaseHasAnalysisOutput")).isEqualTo(true);
  }

  @Test
  void analyzeDirectiveWhenSourcesRead() {
    var data = new HashMap<String, Object>();
    data.put("phaseCursor", "p3");
    data.put(
        "phases",
        List.of(Map.of("id", "p3", "intent", "analyze")));
    data.put(
        "gatheredInfo",
        Map.of(
            "r1",
            Map.of(
                "kind",
                "fs.read",
                "ok",
                true,
                "result",
                Map.of("path", "foo.cpp", "content", "int main(){}"))));
    var state = new OverAllState(data);

    @SuppressWarnings("unchecked")
    Map<String, Object> gathered = (Map<String, Object>) data.get("gatheredInfo");
    String directive = StuckStepRecovery.analyzeTextOutputDirective(state, gathered);
    assertThat(directive).contains("textOutput");
  }
}
