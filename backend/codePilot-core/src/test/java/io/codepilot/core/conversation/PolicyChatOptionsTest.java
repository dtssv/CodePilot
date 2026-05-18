package io.codepilot.core.conversation;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.ai.openai.OpenAiChatOptions;

class PolicyChatOptionsTest {

  @Test
  void appliesMaxTokensAndReasoningForOseries() {
    OpenAiChatOptions opts = PolicyChatOptions.fromGraphState(true, "high", 4096, "o3-mini");
    assertThat(opts).isNotNull();
    assertThat(opts.getMaxTokens()).isEqualTo(4096);
    assertThat(opts.getReasoningEffort()).isEqualTo("high");
  }

  @Test
  void maxModeOnGenericModelSetsTokensOnly() {
    OpenAiChatOptions opts = PolicyChatOptions.fromGraphState(true, null, null, "gpt-4o-mini");
    assertThat(opts).isNotNull();
    assertThat(opts.getMaxTokens()).isEqualTo(8192);
    assertThat(opts.getReasoningEffort()).isNull();
  }

  @Test
  void claudeMaxModeBuildsWithoutReasoningEffort() {
    OpenAiChatOptions opts =
        PolicyChatOptions.fromGraphState(true, "high", 8192, "claude-sonnet-4-20250514");
    assertThat(opts).isNotNull();
    assertThat(opts.getMaxTokens()).isEqualTo(8192);
    assertThat(opts.getReasoningEffort()).isNull();
    assertThat(OpenAiChatOptionsComposer.readExtraBody(opts)).containsKey("thinking");
  }
}
