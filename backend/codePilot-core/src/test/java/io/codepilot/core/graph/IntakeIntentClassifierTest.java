package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class IntakeIntentClassifierTest {

  private final IntakeIntentClassifier classifier =
      new IntakeIntentClassifier(null, null, null, new ObjectMapper());

  @Test
  void parsesToolPlanForAnalysis() throws Exception {
    String json =
        """
        {
          "needsTools": true,
          "needsPlanning": false,
          "tools": [
            {"name": "fs.list", "why": "find cpp files"},
            {"name": "fs.read", "why": "read sources for complexity"}
          ],
          "reason": "Need file contents"
        }
        """;
    IntakeIntent intent = classifier.parseResponse(json);
    assertThat(intent.needsTools()).isTrue();
    assertThat(intent.needsPlanning()).isFalse();
    assertThat(intent.tools()).hasSize(2);
    assertThat(intent.requireFileGather()).isTrue();
    assertThat(intent.allowShellExec()).isFalse();
    assertThat(intent.conversationalOnly()).isFalse();
  }

  @Test
  void parsesShellToolPlan() throws Exception {
    String json =
        """
        {
          "needsTools": true,
          "needsPlanning": false,
          "tools": [{"name": "shell.exec", "why": "compile and run main.cpp"}],
          "reason": "Build and execute"
        }
        """;
    IntakeIntent intent = classifier.parseResponse(json);
    assertThat(intent.allowShellExec()).isTrue();
    assertThat(intent.requireFileGather()).isFalse();
  }

  @Test
  void pureChatNeedsNoTools() throws Exception {
    String json =
        """
        {
          "needsTools": false,
          "needsPlanning": false,
          "tools": [],
          "reason": "General explanation"
        }
        """;
    IntakeIntent intent = classifier.parseResponse(json);
    assertThat(intent.conversationalOnly()).isTrue();
    assertThat(intent.tools()).isEmpty();
  }

  @Test
  void needsToolsWithoutToolsForcesPlanning() throws Exception {
    String json =
        """
        {"needsTools": true, "needsPlanning": false, "tools": [], "reason": "ambiguous"}
        """;
    IntakeIntent intent = classifier.parseResponse(json);
    assertThat(intent.needsPlanning()).isTrue();
  }
}
