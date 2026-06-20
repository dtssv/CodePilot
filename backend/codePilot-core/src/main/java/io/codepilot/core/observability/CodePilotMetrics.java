package io.codepilot.core.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

/**
 * CodePilot custom metrics for observability.
 *
 * <p>Counters: - codepilot_tokens_in: Total input tokens consumed - codepilot_tokens_out: Total
 * output tokens generated - codepilot_agent_steps_total: Total agent steps executed -
 * codepilot_tool_calls_total: Total tool calls invoked
 *
 * <p>Histogram/Timer: - codepilot_latency_seconds: End-to-end latency distribution
 */
@Component
public class CodePilotMetrics {

  private final Counter tokensIn;
  private final Counter tokensOut;
  private final Counter agentStepsTotal;
  private final Counter toolCallsTotal;
  private final Timer latencyTimer;

  public CodePilotMetrics(MeterRegistry registry) {
    this.tokensIn =
        Counter.builder("codepilot_tokens_in")
            .description("Total input tokens consumed")
            .register(registry);

    this.tokensOut =
        Counter.builder("codepilot_tokens_out")
            .description("Total output tokens generated")
            .register(registry);

    this.agentStepsTotal =
        Counter.builder("codepilot_agent_steps_total")
            .description("Total agent steps executed")
            .register(registry);

    this.toolCallsTotal =
        Counter.builder("codepilot_tool_calls_total")
            .description("Total tool calls invoked")
            .register(registry);

    this.latencyTimer =
        Timer.builder("codepilot_latency_seconds")
            .description("End-to-end latency distribution")
            .publishPercentileHistogram()
            .register(registry);
  }

  /** Increment input token counter by the given amount. */
  public void incrementTokensIn(double amount) {
    tokensIn.increment(amount);
  }

  /** Increment output token counter by the given amount. */
  public void incrementTokensOut(double amount) {
    tokensOut.increment(amount);
  }

  /** Increment agent steps counter by 1. */
  public void incrementSteps() {
    agentStepsTotal.increment();
  }

  /** Increment agent steps counter by the given amount. */
  public void incrementSteps(double amount) {
    agentStepsTotal.increment(amount);
  }

  /** Increment tool calls counter by 1. */
  public void incrementToolCalls() {
    toolCallsTotal.increment();
  }

  /** Record an end-to-end latency observation in seconds. */
  public void recordLatency(double seconds) {
    latencyTimer.record(
        (long) (seconds * 1_000_000_000), java.util.concurrent.TimeUnit.NANOSECONDS);
  }

  /** Get the latency timer for use with Timer.sample() for programmatic timing. */
  public Timer getLatencyTimer() {
    return latencyTimer;
  }

  // ---- Convenience methods for common patterns ----

  /** Increment input token counter by 1. */
  public void incrementTokensIn() {
    tokensIn.increment();
  }

  /** Increment output token counter by 1. */
  public void incrementTokensOut() {
    tokensOut.increment();
  }
}
