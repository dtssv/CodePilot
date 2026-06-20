package io.codepilot.core.graph;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

class GraphExecutionMetricsTest {

    @Test
    void recordsLlmAndGatherMetrics() {
        var registry = new SimpleMeterRegistry();
        var metrics = new GraphExecutionMetrics(registry);

        metrics.recordLlmCall("memory-compact", true, 120, 500, 200);
        metrics.recordGatherCacheHit("rag.search");

        assertThat(registry.get("codepilot.graph.llm.calls")
                        .tag("action", "memory-compact")
                        .tag("auxiliary", "true")
                        .counter()
                        .count())
                .isEqualTo(1.0);
        assertThat(registry.get("codepilot.graph.llm.prompt.chars")
                        .tag("action", "memory-compact")
                        .counter()
                        .count())
                .isEqualTo(500.0);
        assertThat(registry.get("codepilot.graph.gather.cache.hits")
                        .tag("kind", "rag.search")
                        .counter()
                        .count())
                .isEqualTo(1.0);
    }
}
