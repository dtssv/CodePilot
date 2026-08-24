package io.codepilot.core.model;

import java.util.List;

/**
 * Chat request — mirrors harness-core's
 * {@code io.codepilot.harness.model.ChatRequest}.
 *
 * <p>The gateway deserializes this from the plugin's HTTP POST body and
 * passes it to the selected {@link ChatModel}.
 */
public record ChatRequest(
        String system,
        List<ChatMessage> messages,
        List<ToolCallSpec> tools,
        List<ToolSchema> toolSchemas,
        double temperature,
        Integer maxTokens) {
}
