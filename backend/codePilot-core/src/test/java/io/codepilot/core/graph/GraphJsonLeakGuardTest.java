package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class GraphJsonLeakGuardTest {

  @Test
  void detectsGenerateJsonEnvelope() {
    String json =
        """
        { "thought": "x", "toolCalls": [{"id":"a","kind":"fs.read"}], "agentContent": null }
        """;
    assertThat(GraphJsonLeakGuard.looksLikeGraphGenerateJson(json)).isTrue();
  }

  @Test
  void allowsNormalProse() {
    assertThat(GraphJsonLeakGuard.looksLikeGraphGenerateJson("我将编译 main.cpp")).isFalse();
  }
}
