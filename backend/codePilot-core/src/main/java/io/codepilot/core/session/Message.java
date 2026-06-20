package io.codepilot.core.session;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

/**
 * A single message in the conversation history.
 *
 * <p>Unified message type covering all roles: SYSTEM, USER, ASSISTANT, and TOOL.
 * {@code MessageV2} which uses discriminated parts,
 * but simplified for Java's type system.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record Message(
    /** Unique message identifier. */
    String id,
    /** Message role. */
    Role role,
    /** Text content of the message. For TOOL role, this is the tool result. */
    String content,
    /** For ASSISTANT messages: tool calls requested by the model. */
    List<ToolCallEntry> toolCalls,
    /** For TOOL messages: the tool call ID this result corresponds to. */
    String toolCallId,
    /** For TOOL messages: the name of the tool that was called. */
    String toolName,
    /** Thinking/reasoning content (for models that support it). */
    String thinking,
    /** Timestamp in epoch millis. */
    long timestamp,
    /** Token usage for this message (for ASSISTANT messages from the LLM). */
    TokenUsage usage,
    /** Arbitrary metadata attached to this message. */
    Map<String, Object> metadata) {

  /** Message role in the conversation. */
  public enum Role {
    @JsonProperty("system") SYSTEM,
    @JsonProperty("user") USER,
    @JsonProperty("assistant") ASSISTANT,
    @JsonProperty("tool") TOOL
  }

  /** A single tool call entry within an ASSISTANT message. */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record ToolCallEntry(
      /** Unique ID for this tool call (from the LLM provider). */
      String id,
      /** Tool name. */
      String name,
      /** Parsed arguments. */
      Map<String, Object> args) {}

  /** Token usage for a single LLM response. */
  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record TokenUsage(
      int inputTokens,
      int outputTokens,
      int reasoningTokens,
      int cacheReadTokens,
      int cacheWriteTokens) {

    public int totalTokens() {
      return inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
    }

    public static TokenUsage empty() {
      return new TokenUsage(0, 0, 0, 0, 0);
    }
  }

  // ── Convenience factory methods ──

  public static Message system(String content) {
    return new Message(null, Role.SYSTEM, content, null, null, null, null, System.currentTimeMillis(), null, null);
  }

  public static Message user(String content) {
    return new Message(null, Role.USER, content, null, null, null, null, System.currentTimeMillis(), null, null);
  }

  public static Message assistant(String content, List<ToolCallEntry> toolCalls, String thinking, TokenUsage usage) {
    return new Message(null, Role.ASSISTANT, content, toolCalls, null, null, thinking, System.currentTimeMillis(), usage, null);
  }

  public static Message toolResult(String toolCallId, String toolName, String content) {
    return new Message(null, Role.TOOL, content, null, toolCallId, toolName, null, System.currentTimeMillis(), null, null);
  }

  @SuppressWarnings("unchecked")
  public static Message fromRow(Map<String, Object> row, com.fasterxml.jackson.databind.ObjectMapper mapper) {
    try {
      return new Message(
          (String) row.get("id"),
          Role.valueOf((String) row.get("role")),
          (String) row.get("content"),
          mapper.readValue(row.get("tool_calls_json").toString(), List.class),
          (String) row.get("tool_call_id"),
          (String) row.get("tool_name"),
          (String) row.get("thinking"),
          ((java.sql.Timestamp) row.get("created_at")).toInstant().toEpochMilli(),
          mapper.readValue(row.get("usage_json").toString(), TokenUsage.class),
          null
      );
    } catch (Exception e) {
      throw new RuntimeException("Failed to deserialize message", e);
    }
  }

  public boolean hasToolCalls() {
    return toolCalls != null && !toolCalls.isEmpty();
  }
}
