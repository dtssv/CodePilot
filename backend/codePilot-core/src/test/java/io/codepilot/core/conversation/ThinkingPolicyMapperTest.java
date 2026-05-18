package io.codepilot.core.conversation;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ThinkingPolicyMapperTest {

  @Test
  void mapsThinkingModeToReasoningEffort() {
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, "high", "o3-mini").orElseThrow())
        .isEqualTo("high");
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, "low", "o3-mini").orElseThrow())
        .isEqualTo("low");
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, "off", "o3-mini")).isEmpty();
  }

  @Test
  void maxModeDefaultsToMediumWhenThinkingUnset() {
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, null, "o1-preview").orElseThrow())
        .isEqualTo("medium");
  }

  @Test
  void skipsReasoningForUnknownModelsUnlessExplicitThinkingModel() {
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, "high", "gpt-4o-mini")).isEmpty();
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, "high", "o3-mini").orElseThrow())
        .isEqualTo("high");
  }

  @Test
  void noReasoningWithoutMaxMode() {
    assertThat(ThinkingPolicyMapper.reasoningEffort(false, "high", "o3-mini")).isEmpty();
  }

  @Test
  void claudeUsesAnthropicThinkingExtraNotReasoningEffort() {
    var extra =
        ThinkingPolicyMapper.anthropicThinkingExtra(true, "high", "claude-sonnet-4-20250514");
    assertThat(extra).isPresent();
    assertThat(extra.get()).containsKey("thinking");
    assertThat(ThinkingPolicyMapper.reasoningEffort(true, "high", "claude-sonnet-4-20250514"))
        .isEmpty();
    assertThat(ThinkingPolicyMapper.thinkingTransport(true, "high", "claude-sonnet-4-20250514"))
        .contains("anthropic-extra");
  }

  @Test
  void anthropicBudgetScalesWithMode() {
    assertThat(ThinkingPolicyMapper.thinkingBudgetTokens("low", true)).isEqualTo(4096);
    assertThat(ThinkingPolicyMapper.thinkingBudgetTokens("high", true)).isEqualTo(20_000);
  }
}
