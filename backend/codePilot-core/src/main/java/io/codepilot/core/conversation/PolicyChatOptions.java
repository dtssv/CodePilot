package io.codepilot.core.conversation;

import io.codepilot.core.dto.ConversationRunRequest;
import org.springframework.ai.openai.OpenAiChatOptions;

/**
 * Maps conversation policy (Max mode, thinking budget) to Spring AI chat options.
 */
public final class PolicyChatOptions {

  private PolicyChatOptions() {}

  public static OpenAiChatOptions fromPolicy(ConversationRunRequest.Policy policy) {
    return fromPolicy(policy, null);
  }

  public static OpenAiChatOptions fromPolicy(ConversationRunRequest.Policy policy, String modelId) {
    if (policy == null) return null;
    return build(
        Boolean.TRUE.equals(policy.maxMode()),
        policy.thinkingMode(),
        policy.maxOutputTokens(),
        modelId);
  }

  public static OpenAiChatOptions fromGraphState(
      Boolean maxMode, String thinkingMode, Integer maxOutputTokens, String modelId) {
    return build(
        Boolean.TRUE.equals(maxMode),
        thinkingMode,
        maxOutputTokens,
        modelId);
  }

  private static OpenAiChatOptions build(
      boolean maxMode, String thinkingMode, Integer maxOutputTokens, String modelId) {
    int tokens = maxOutputTokens != null ? maxOutputTokens : (maxMode ? 8192 : 0);
    boolean hasReasoning =
        ThinkingPolicyMapper.reasoningEffort(maxMode, thinkingMode, modelId).isPresent();
    boolean hasAnthropicThinking =
        ThinkingPolicyMapper.anthropicThinkingExtra(maxMode, thinkingMode, modelId).isPresent();
    if (tokens <= 0 && !maxMode && !hasReasoning && !hasAnthropicThinking) return null;

    OpenAiChatOptions.Builder builder = OpenAiChatOptions.builder();
    if (tokens > 0) builder.maxTokens(tokens);
    ThinkingPolicyMapper.reasoningEffort(maxMode, thinkingMode, modelId)
        .ifPresent(builder::reasoningEffort);
    ThinkingPolicyMapper.anthropicThinkingExtra(maxMode, thinkingMode, modelId)
        .ifPresent(extra -> OpenAiChatOptionsComposer.applyExtraBody(builder, extra));
    return builder.build();
  }

  private static OpenAiChatOptions build(
      boolean maxMode, String thinkingMode, Integer maxOutputTokens) {
    return build(maxMode, thinkingMode, maxOutputTokens, null);
  }
}
