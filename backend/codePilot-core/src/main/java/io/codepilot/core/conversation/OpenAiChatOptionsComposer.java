package io.codepilot.core.conversation;

import java.util.Map;
import org.springframework.ai.openai.OpenAiChatOptions;

/** Applies provider-specific {@code extraBody} on Spring AI 1.0.4+ {@link OpenAiChatOptions}. */
final class OpenAiChatOptionsComposer {

  private OpenAiChatOptionsComposer() {}

  static void applyExtraBody(OpenAiChatOptions.Builder builder, Map<String, Object> extra) {
    if (extra == null || extra.isEmpty()) {
      return;
    }
    builder.extraBody(extra);
  }

  static Map<String, Object> readExtraBody(OpenAiChatOptions options) {
    if (options == null) {
      return Map.of();
    }
    Map<String, Object> body = options.getExtraBody();
    return body != null ? body : Map.of();
  }
}
