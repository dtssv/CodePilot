package io.codepilot.core.conversation;

import io.codepilot.core.context.TokenMeter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Dynamic context window manager for conversation messages.
 *
 * <p>Manages the conversation context window with importance-based eviction,
 * incremental compaction, and cost tracking. Mirrors Cursor's approach:
 * <ol>
 *   <li>Track per-message token usage and importance</li>
 *   <li>When approaching budget, evict low-importance messages first</li>
 *   <li>Compact older messages into summaries to retain context</li>
 *   <li>Always preserve recent context (last N messages)</li>
 * </ol>
 *
 * <h3>Eviction Priority (high to low retention):</h3>
 * <ol>
 *   <li>System prompt (importance=1.0, never evicted)</li>
 *   <li>Current user query (importance=0.9)</li>
 *   <li>Recent user messages (importance=0.8)</li>
 *   <li>Recent assistant turns with tool calls (importance=0.7)</li>
 *   <li>Old tool results (importance=0.5)</li>
 *   <li>Old assistant messages without tool calls (importance=0.4)</li>
 * </ol>
 */
@Component
public class ContextWindowManager {

    private static final Logger log = LoggerFactory.getLogger(ContextWindowManager.class);
    private final TokenMeter meter;

    public ContextWindowManager(TokenMeter meter) {
        this.meter = meter;
    }

    /** A message in the context window with its metadata. */
    public record WindowMessage(
        String content,
        MessageMeta meta
    ) {}

    /** Result of a context window trim operation. */
    public record TrimResult(
        List<WindowMessage> kept,
        List<WindowMessage> evicted,
        int totalTokensBefore,
        int totalTokensAfter,
        int tokensSaved,
        boolean compacted
    ) {}

    /**
     * Trim a list of messages to fit within the token budget.
     * Uses importance-based eviction: remove lowest-importance messages first,
     * then compact remaining older messages if still over budget.
     *
     * @param messages the full conversation messages (oldest first)
     * @param budget the maximum token budget
     * @param keepRecent minimum number of recent messages to always keep
     * @return trim result with kept/evicted messages and stats
     */
    public TrimResult trim(List<WindowMessage> messages, int budget, int keepRecent) {
        int totalBefore = countTokens(messages);
        if (totalBefore <= budget) {
            return new TrimResult(messages, List.of(), totalBefore, totalBefore, 0, false);
        }

        List<WindowMessage> working = new ArrayList<>(messages);
        List<WindowMessage> evicted = new ArrayList<>();

        // Phase 1: Evict low-importance messages (keep recent N)
        List<Integer> evictionOrder = new ArrayList<>();
        for (int i = 0; i < working.size() - keepRecent; i++) {
            evictionOrder.add(i);
        }
        // Sort by importance ascending (lowest evicted first)
        evictionOrder.sort(Comparator.comparingDouble(i -> working.get(i).meta().importance()));

        for (int idx : evictionOrder) {
            if (countTokens(working) <= budget) break;
            WindowMessage removed = working.get(idx);
            if (removed != null) {
                evicted.add(removed);
                working.set(idx, null);
            }
        }

        // Remove nulls
        working.removeIf(m -> m == null);

        // Phase 2: Compact older messages if still over budget
        boolean compacted = false;
        if (countTokens(working) > budget && working.size() > keepRecent + 1) {
            int splitPoint = working.size() - keepRecent;
            List<WindowMessage> toCompact = new ArrayList<>(working.subList(0, splitPoint));

            String summary = compactMessages(toCompact);
            MessageMeta summaryMeta = MessageMeta.system(
                UUID.randomUUID().toString(),
                meter.count(summary)
            );

            List<WindowMessage> compactedList = new ArrayList<>();
            compactedList.add(new WindowMessage(summary, summaryMeta));
            compactedList.addAll(working.subList(splitPoint, working.size()));

            working = compactedList;
            compacted = true;
        }

        int totalAfter = countTokens(working);
        log.info("Context window trimmed: {} -> {} tokens (saved {}, compacted={})",
            totalBefore, totalAfter, totalBefore - totalAfter, compacted);

        return new TrimResult(working, evicted, totalBefore, totalAfter, totalBefore - totalAfter, compacted);
    }

    /**
     * Calculate the importance score for a message based on its role and position.
     */
    public double calculateImportance(WindowMessage msg, int position, int totalMessages) {
        double base = msg.meta().importance();
        double recencyBoost = (double) position / totalMessages * 0.2;
        double refBoost = msg.meta().references() != null && !msg.meta().references().isEmpty() ? 0.1 : 0.0;
        return Math.min(1.0, base + recencyBoost + refBoost);
    }

    /**
     * Generate a session cost summary for all messages.
     */
    public SessionCostSummary calculateCostSummary(List<WindowMessage> messages) {
        int totalInput = 0;
        int totalOutput = 0;
        double totalCost = 0.0;
        int messageCount = messages.size();

        for (WindowMessage msg : messages) {
            totalInput += msg.meta().inputTokens();
            totalOutput += msg.meta().outputTokens();
            totalCost += msg.meta().estimatedCost();
        }

        return new SessionCostSummary(messageCount, totalInput, totalOutput, totalCost);
    }

    /** Summary of session token usage and cost. */
    public record SessionCostSummary(
        int messageCount,
        int totalInputTokens,
        int totalOutputTokens,
        double estimatedCostUsd
    ) {}

    private int countTokens(List<WindowMessage> messages) {
        return messages.stream()
            .mapToInt(m -> m.meta().totalTokens())
            .sum();
    }

    /**
     * Compact a list of messages into a concise summary.
     * Uses non-model mathematical summarization (key-fact extraction).
     */
    private String compactMessages(List<WindowMessage> messages) {
        StringBuilder sb = new StringBuilder();
        sb.append("[Context Summary]\n");
        sb.append("The following conversation context has been compacted:\n\n");

        for (WindowMessage msg : messages) {
            String role = msg.meta().role();
            String content = msg.content();

            switch (role) {
                case "user" -> {
                    String truncated = content.length() > 200
                        ? content.substring(0, 200) + "..." : content;
                    sb.append("- User asked: ").append(truncated).append("\n");
                }
                case "assistant" -> {
                    if (content.contains("tool_call") || content.contains("function_call")) {
                        sb.append("- Assistant performed tool operations\n");
                    } else {
                        String truncated = content.length() > 150
                            ? content.substring(0, 150) + "..." : content;
                        sb.append("- Assistant responded: ").append(truncated).append("\n");
                    }
                }
                case "tool" -> {
                    sb.append("- Tool result (").append(msg.meta().inputTokens())
                        .append(" tokens)\n");
                }
                default -> {}
            }
        }

        return sb.toString();
    }
}