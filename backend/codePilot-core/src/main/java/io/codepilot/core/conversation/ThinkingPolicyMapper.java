package io.codepilot.core.conversation;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * Maps CodePilot policy {@code thinkingMode} to provider-native reasoning parameters.
 *
 * <p>OpenAI o-series: {@code reasoningEffort}. Claude (OpenAI-compatible gateways): {@code thinking}
 * block via {@code extraBody} (Spring AI 1.0.4+).
 */
public final class ThinkingPolicyMapper {

  private ThinkingPolicyMapper() {}

  /**
   * @param modelId optional model id/name for capability gating (may be null)
   * @return reasoning_effort value when the model likely supports it
   */
  public static Optional<String> reasoningEffort(
      boolean maxMode, String thinkingMode, String modelId) {
    if (anthropicThinkingExtra(maxMode, thinkingMode, modelId).isPresent()) {
      return Optional.empty();
    }
    String mode = normalizeThinkingMode(thinkingMode);
    if ("off".equals(mode)) {
      return Optional.empty();
    }
    if (!maxMode) {
      return Optional.empty();
    }
    String effort = mapToEffort(mode, maxMode);
    if (effort == null) return Optional.empty();
    if (modelId != null && !modelId.isBlank() && !modelLikelySupportsReasoning(modelId)) {
      return Optional.empty();
    }
    return Optional.of(effort);
  }

  /**
   * Anthropic extended thinking for Claude models on OpenAI-compatible gateways.
   *
   * @see <a href="https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking">Extended thinking</a>
   */
  public static Optional<Map<String, Object>> anthropicThinkingExtra(
      boolean maxMode, String thinkingMode, String modelId) {
    String mode = normalizeThinkingMode(thinkingMode);
    if ("off".equals(mode)) {
      return Optional.empty();
    }
    if (!maxMode && mode == null) {
      return Optional.empty();
    }
    if (modelId == null || modelId.isBlank() || !modelLikelySupportsAnthropicThinking(modelId)) {
      return Optional.empty();
    }
    int budget = thinkingBudgetTokens(mode, maxMode);
    if (budget <= 0) return Optional.empty();
    Map<String, Object> thinking =
        Map.of("type", "enabled", "budget_tokens", budget);
    return Optional.of(Map.of("thinking", thinking));
  }

  /** Which thinking transport applies for UI hints. */
  public static Optional<String> thinkingTransport(
      boolean maxMode, String thinkingMode, String modelId) {
    if (anthropicThinkingExtra(maxMode, thinkingMode, modelId).isPresent()) {
      return Optional.of("anthropic-extra");
    }
    if (reasoningEffort(maxMode, thinkingMode, modelId).isPresent()) {
      return Optional.of("openai-reasoning");
    }
    return Optional.empty();
  }

  static int thinkingBudgetTokens(String mode, boolean maxMode) {
    if (mode == null) {
      return maxMode ? 10_000 : 0;
    }
    return switch (mode) {
      case "off", "none", "disabled" -> 0;
      case "low", "minimal" -> 4_096;
      case "medium", "default", "balanced" -> 10_000;
      case "high", "max", "deep" -> maxMode ? 20_000 : 16_000;
      default -> maxMode ? 10_000 : 0;
    };
  }

  static String normalizeThinkingMode(String thinkingMode) {
    if (thinkingMode == null || thinkingMode.isBlank()) return null;
    return thinkingMode.trim().toLowerCase(Locale.ROOT);
  }

  static String mapToEffort(String mode, boolean maxMode) {
    if (mode == null) {
      return maxMode ? "medium" : null;
    }
    return switch (mode) {
      case "off", "none", "disabled" -> null;
      case "low", "minimal" -> "low";
      case "medium", "default", "balanced" -> "medium";
      case "high", "max", "deep" -> "high";
      default -> maxMode ? "medium" : null;
    };
  }

  /**
   * Heuristic: OpenAI reasoning models and common aliases on OpenAI-compatible gateways.
   */
  static boolean modelLikelySupportsReasoning(String modelId) {
    String id = modelId.toLowerCase(Locale.ROOT);
    if (id.contains("reasoning") || id.contains("thinking")) return true;
    if (id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) return true;
    if (id.contains("gpt-5") || id.contains("gpt5")) return true;
    if (id.contains("claude") && (id.contains("sonnet-4") || id.contains("opus-4"))) return true;
    return false;
  }

  static boolean modelLikelySupportsAnthropicThinking(String modelId) {
    String id = modelId.toLowerCase(Locale.ROOT);
    if (!id.contains("claude")) return false;
    if (id.contains("sonnet-4") || id.contains("opus-4") || id.contains("3-7") || id.contains("3.7")) {
      return true;
    }
    return id.contains("thinking") || id.contains("extended");
  }
}
