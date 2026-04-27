package io.codepilot.core.metrics;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

/**
 * Centralized metrics helper for CodePilot observability.
 *
 * <p>Metrics exposed:
 * <ul>
 *   <li>{@code codepilot.tokens.in}    — Total input tokens consumed</li>
 *   <li>{@code codepilot.tokens.out}   — Total output tokens generated</li>
 *   <li>{@code codepilot.tool.calls}   — Tool invocation count (by tool name)</li>
 *   <li>{@code codepilot.agent.latency} — Agent loop latency distribution</li>
 *   <li>{@code codepilot.action.calls}  — Action invocation count (by action type)</li>
 *   <li>{@code codepilot.rag.indexed}   — RAG documents indexed count</li>
 *   <li>{@code codepilot.rag.searches}  — RAG search count</li>
 * </ul>
 */
@Component
public class MetricsHelper {

  private final MeterRegistry registry;

  public MetricsHelper(MeterRegistry registry) {
    this.registry = registry;
  }

  // ── Token metrics ──────────────────────────────────────────────────

  public void recordTokensIn(String model, long tokens) {
    Counter.builder("codepilot.tokens.in")
        .tag("model", model)
        .register(registry)
        .increment(tokens);
  }

  public void recordTokensOut(String model, long tokens) {
    Counter.builder("codepilot.tokens.out")
        .tag("model", model)
        .register(registry)
        .increment(tokens);
  }

  // ── Tool call metrics ──────────────────────────────────────────────

  public void recordToolCall(String toolName, boolean success) {
    Counter.builder("codepilot.tool.calls")
        .tag("tool", toolName)
        .tag("success", String.valueOf(success))
        .register(registry)
        .increment();
  }

  // ── Agent latency ──────────────────────────────────────────────────

  public void recordAgentLatency(String model, long durationMs) {
    Timer.builder("codepilot.agent.latency")
        .tag("model", model)
        .register(registry)
        .record(durationMs, TimeUnit.MILLISECONDS);
  }

  // ── Action metrics ─────────────────────────────────────────────────

  public void recordActionCall(String actionType, boolean success) {
    Counter.builder("codepilot.action.calls")
        .tag("type", actionType)
        .tag("success", String.valueOf(success))
        .register(registry)
        .increment();
  }

  // ── RAG metrics ────────────────────────────────────────────────────

  public void recordRagIndexed(int count) {
    Counter.builder("codepilot.rag.indexed")
        .register(registry)
        .increment(count);
  }

  public void recordRagSearch() {
    Counter.builder("codepilot.rag.searches")
        .register(registry)
        .increment();
  }
}