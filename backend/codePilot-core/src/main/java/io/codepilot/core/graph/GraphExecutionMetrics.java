package io.codepilot.core.graph;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

/** Prometheus/Micrometer metrics for graph-engine LLM calls and gather cache. */
@Component
public class GraphExecutionMetrics {

    private static final String LLM_CALLS = "codepilot.graph.llm.calls";
    private static final String LLM_DURATION = "codepilot.graph.llm.duration";
    private static final String LLM_PROMPT_CHARS = "codepilot.graph.llm.prompt.chars";
    private static final String LLM_RESPONSE_CHARS = "codepilot.graph.llm.response.chars";
    private static final String GATHER_CACHE_HITS = "codepilot.graph.gather.cache.hits";

    private final MeterRegistry registry;

    public GraphExecutionMetrics(MeterRegistry registry) {
        this.registry = registry;
    }

    public void recordLlmCall(String action, boolean auxiliary, long durationMs, int promptChars, int responseChars) {
        String safeAction = action == null || action.isBlank() ? "unknown" : action;
        String auxTag = String.valueOf(auxiliary);
        registry.counter(LLM_CALLS, "action", safeAction, "auxiliary", auxTag).increment();
        registry
                .timer(LLM_DURATION, "action", safeAction, "auxiliary", auxTag)
                .record(java.time.Duration.ofMillis(Math.max(0, durationMs)));
        if (promptChars > 0) {
            registry.counter(LLM_PROMPT_CHARS, "action", safeAction).increment(promptChars);
        }
        if (responseChars > 0) {
            registry.counter(LLM_RESPONSE_CHARS, "action", safeAction).increment(responseChars);
        }
    }

    public void recordGatherCacheHit(String kind) {
        String safeKind = kind == null || kind.isBlank() ? "unknown" : kind;
        registry.counter(GATHER_CACHE_HITS, "kind", safeKind).increment();
    }
}
