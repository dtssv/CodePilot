package io.codepilot.core.observability;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * PromptBudgetEvent — Records token budget consumption events for observability.
 *
 * Tracks:
 * - How many tokens were budgeted vs consumed per request
 * - Which context layers were pruned (and how many tokens saved)
 * - Whether LazyRef resolution was budget-limited
 * - Compression ratio when digest is applied
 *
 * Events are stored in a ring buffer (last 1000) and exposed via
 * MetricsController for Prometheus scraping and debugging.
 */
public class PromptBudgetEvent {

    private static final Logger log = LoggerFactory.getLogger(PromptBudgetEvent.class);
    private static final int MAX_EVENTS = 1000;
    private static final ConcurrentLinkedQueue<Record> ringBuffer = new ConcurrentLinkedQueue<>();

    public record Record(
        String sessionId,
        String mode,
        int budgetTokens,
        int consumedTokens,
        int prunedTokens,
        int lazyRefResolved,
        int lazyRefBudgetLimited,
        double compressionRatio,
        String prunedLayers,
        long timestampMs
    ) {}

    /**
     * Record a prompt budget consumption event.
     */
    public static void record(
        String sessionId,
        String mode,
        int budgetTokens,
        int consumedTokens,
        int prunedTokens,
        int lazyRefResolved,
        int lazyRefBudgetLimited,
        double compressionRatio,
        String prunedLayers
    ) {
        Record r = new Record(
            sessionId, mode, budgetTokens, consumedTokens, prunedTokens,
            lazyRefResolved, lazyRefBudgetLimited, compressionRatio,
            prunedLayers, System.currentTimeMillis()
        );

        ringBuffer.add(r);
        // Trim to max size
        while (ringBuffer.size() > MAX_EVENTS) {
            ringBuffer.poll();
        }

        log.debug("PromptBudget: session={} mode={} budget={} consumed={} pruned={} lazyRef={}/{} compression={}",
            sessionId, mode, budgetTokens, consumedTokens, prunedTokens,
            lazyRefResolved, lazyRefResolved + lazyRefBudgetLimited, String.format("%.2f", compressionRatio));
    }

    /**
     * Get recent events (for debugging / MetricsController).
     */
    public static Record[] recentEvents(int limit) {
        return ringBuffer.stream()
            .skip(Math.max(0, ringBuffer.size() - limit))
            .toArray(Record[]::new);
    }

    /**
     * Aggregate stats for Prometheus metrics.
     */
    public static Map<String, Number> aggregateStats() {
        long count = ringBuffer.size();
        if (count == 0) return Map.of("count", 0L);

        double avgBudget = ringBuffer.stream().mapToInt(Record::budgetTokens).average().orElse(0);
        double avgConsumed = ringBuffer.stream().mapToInt(Record::consumedTokens).average().orElse(0);
        double avgPruned = ringBuffer.stream().mapToInt(Record::prunedTokens).average().orElse(0);
        double avgCompression = ringBuffer.stream().mapToDouble(Record::compressionRatio).average().orElse(0);
        long budgetLimited = ringBuffer.stream().mapToInt(Record::lazyRefBudgetLimited).filter(i -> i > 0).count();

        return Map.of(
            "count", count,
            "avg_budget", avgBudget,
            "avg_consumed", avgConsumed,
            "avg_pruned", avgPruned,
            "avg_compression_ratio", avgCompression,
            "budget_limited_count", budgetLimited
        );
    }
}