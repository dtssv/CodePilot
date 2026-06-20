package io.codepilot.core.agent.tool;

import java.util.Map;

/**
 * Simplified tool call representing a model's request to execute a tool.
 *
 * <p>This is the internal representation of a tool call, decoupled from Spring AI's OpenAI-specific
 * format.
 */
public record ToolCall(
    String callId, String toolName, Map<String, Object> args, String sessionId) {}
