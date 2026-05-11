package io.codepilot.core.conversation;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.Map;

/**
 * Per-message metadata for conversation messages.
 * Tracks token usage, importance, references, and context lifecycle.
 *
 * <p>Cursor tracks per-message metadata to enable:
 * <ul>
 *   <li>Token budget accounting per message</li>
 *   <li>Importance-based eviction (less important messages pruned first)</li>
 *   <li>Reference tracking (which @refs were in each message)</li>
 *   <li>Cost attribution (tokens → cost estimation)</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MessageMeta(
    /** Unique message ID */
    String messageId,
    /** Message role: user, assistant, system, tool */
    String role,
    /** Token count for this message (input tokens) */
    int inputTokens,
    /** Token count for model output (assistant messages only) */
    int outputTokens,
    /** Importance score 0-1 (1=critical, 0=evictable) */
    double importance,
    /** Timestamp when message was created */
    Instant createdAt,
    /** References included in this message (@file, @symbol, etc.) */
    Map<String, String> references,
    /** Whether this message has been compacted/summarized */
    boolean compacted,
    /** Original message ID if this is a compacted version */
    String compactedFromId,
    /** Tool call ID if this is a tool result message */
    String toolCallId,
    /** Model ID used for this message */
    String modelId,
    /** Branch ID for conversation branching */
    String branchId
) {
    /** Create meta for a user message */
    public static MessageMeta user(String messageId, int inputTokens, Map<String, String> refs) {
        return new MessageMeta(
            messageId, "user", inputTokens, 0,
            0.8, Instant.now(), refs,
            false, null, null, null, null
        );
    }

    /** Create meta for an assistant message */
    public static MessageMeta assistant(String messageId, int inputTokens, int outputTokens, String modelId) {
        return new MessageMeta(
            messageId, "assistant", inputTokens, outputTokens,
            0.6, Instant.now(), Map.of(),
            false, null, null, modelId, null
        );
    }

    /** Create meta for a system message */
    public static MessageMeta system(String messageId, int inputTokens) {
        return new MessageMeta(
            messageId, "system", inputTokens, 0,
            1.0, Instant.now(), Map.of(),
            false, null, null, null, null
        );
    }

    /** Create meta for a tool result message */
    public static MessageMeta toolResult(String messageId, int inputTokens, String toolCallId) {
        return new MessageMeta(
            messageId, "tool", inputTokens, 0,
            0.5, Instant.now(), Map.of(),
            false, null, toolCallId, null, null
        );
    }

    /** Create a compacted version of this meta */
    public MessageMeta compacted(String newId) {
        return new MessageMeta(
            newId, role, inputTokens, outputTokens,
            importance * 0.9, // Slightly lower importance after compaction
            createdAt, references,
            true, messageId, toolCallId, modelId, branchId
        );
    }

    /** Calculate total tokens (input + output) */
    public int totalTokens() {
        return inputTokens + outputTokens;
    }

    /** Estimate cost in USD (approximate for GPT-4 class models) */
    public double estimatedCost() {
        double inputCostPer1k = 0.03;  // $0.03/1K input tokens
        double outputCostPer1k = 0.06; // $0.06/1K output tokens
        return (inputTokens * inputCostPer1k + outputTokens * outputCostPer1k) / 1000.0;
    }
}