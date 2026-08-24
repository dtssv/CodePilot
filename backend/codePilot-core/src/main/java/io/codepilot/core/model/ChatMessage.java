package io.codepilot.core.model;

import java.util.List;

/**
 * Chat message — mirrors harness-core's
 * {@code io.codepilot.harness.model.ChatMessage}.
 */
public record ChatMessage(
        Role role,
        String text,
        List<ToolCallSpec> toolCalls,
        String toolCallId) {

    public enum Role { SYSTEM, USER, ASSISTANT, TOOL }
}
