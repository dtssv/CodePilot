package io.codepilot.api.metrics;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Real-time metrics endpoint exposing Prometheus-format metrics and JSON health API.
 *
 * <p>Metrics: chat/agent/completion requests, tokens, errors, latency histogram, active sessions,
 * Shadow validations, MCP servers.
 */
@RestController
@RequestMapping("/v1/metrics")
public class MetricsController {

  private static final Logger log = LoggerFactory.getLogger(MetricsController.class);

  private final LongAdder chatRequests = new LongAdder();
  private final LongAdder agentRequests = new LongAdder();
  private final LongAdder completionRequests = new LongAdder();
  private final LongAdder inputTokens = new LongAdder();
  private final LongAdder outputTokens = new LongAdder();
  private final LongAdder shadowValidations = new LongAdder();
  private final LongAdder shadowValidationFailures = new LongAdder();
  private final ConcurrentHashMap<String, LongAdder> errorsByType = new ConcurrentHashMap<>();
  private final ConcurrentHashMap<String, AtomicLong> latencyBuckets = new ConcurrentHashMap<>();
  private final double[] latencyBucketBounds = {0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0};
  private final AtomicLong activeSessions = new AtomicLong(0);
  private final AtomicLong mcpServersActive = new AtomicLong(0);
  private final Instant startTime = Instant.now();

  public MetricsController() {
    for (double bound : latencyBucketBounds) {
      latencyBuckets.put(bound + "", new AtomicLong(0));
    }
    latencyBuckets.put("+Inf", new AtomicLong(0));
  }

  /** Prometheus-format metrics endpoint. */
  @GetMapping(produces = MediaType.TEXT_PLAIN_VALUE)
  public ResponseEntity<String> prometheusMetrics() {
    StringBuilder sb = new StringBuilder();
    appendMetric(
        sb, "codepilot_chat_requests_total", "counter", "Total chat requests", chatRequests.sum());
    appendMetric(
        sb,
        "codepilot_agent_requests_total",
        "counter",
        "Total agent requests",
        agentRequests.sum());
    appendMetric(
        sb,
        "codepilot_completion_requests_total",
        "counter",
        "Total FIM completion requests",
        completionRequests.sum());
    appendMetric(
        sb, "codepilot_tokens_input_total", "counter", "Total input tokens", inputTokens.sum());
    appendMetric(
        sb, "codepilot_tokens_output_total", "counter", "Total output tokens", outputTokens.sum());
    appendMetric(
        sb,
        "codepilot_shadow_validations_total",
        "counter",
        "Shadow validations",
        shadowValidations.sum());
    appendMetric(
        sb,
        "codepilot_shadow_validation_failures_total",
        "counter",
        "Shadow validation failures",
        shadowValidationFailures.sum());
    appendMetric(sb, "codepilot_active_sessions", "gauge", "Active sessions", activeSessions.get());
    appendMetric(
        sb, "codepilot_mcp_servers_active", "gauge", "Active MCP servers", mcpServersActive.get());
    appendMetric(
        sb,
        "codepilot_uptime_seconds",
        "gauge",
        "Uptime seconds",
        Duration.between(startTime, Instant.now()).getSeconds());

    for (var entry : errorsByType.entrySet()) {
      sb.append("# HELP codepilot_errors_total Total errors by type\n");
      sb.append("# TYPE codepilot_errors_total counter\n");
      sb.append("codepilot_errors_total{type=\"")
          .append(entry.getKey())
          .append("\"} ")
          .append(entry.getValue().sum())
          .append("\n");
    }

    sb.append("# HELP codepilot_request_latency_seconds Request latency\n");
    sb.append("# TYPE codepilot_request_latency_seconds histogram\n");
    for (var entry : latencyBuckets.entrySet()) {
      sb.append("codepilot_request_latency_seconds_bucket{le=\"")
          .append(entry.getKey())
          .append("\"} ")
          .append(entry.getValue().get())
          .append("\n");
    }

    return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body(sb.toString());
  }

  /** JSON health metrics endpoint. */
  @GetMapping(value = "/health", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<Map<String, Object>> healthMetrics() {
    long uptime = Duration.between(startTime, Instant.now()).getSeconds();
    return ResponseEntity.ok(
        Map.of(
            "status",
            "UP",
            "uptime_seconds",
            uptime,
            "metrics",
            Map.of(
                "chat_requests", chatRequests.sum(),
                "agent_requests", agentRequests.sum(),
                "completion_requests", completionRequests.sum(),
                "input_tokens", inputTokens.sum(),
                "output_tokens", outputTokens.sum(),
                "active_sessions", activeSessions.get(),
                "shadow_validations", shadowValidations.sum(),
                "shadow_failures", shadowValidationFailures.sum(),
                "mcp_servers_active", mcpServersActive.get(),
                "errors_by_type",
                    errorsByType.entrySet().stream()
                        .collect(
                            java.util.stream.Collectors.toMap(
                                Map.Entry::getKey, e -> e.getValue().sum())))));
  }

  // Record methods
  public void recordChatRequest() {
    chatRequests.increment();
  }

  public void recordAgentRequest() {
    agentRequests.increment();
  }

  public void recordCompletionRequest() {
    completionRequests.increment();
  }

  public void recordInputTokens(int count) {
    inputTokens.add(count);
  }

  public void recordOutputTokens(int count) {
    outputTokens.add(count);
  }

  public void recordShadowValidation(boolean success) {
    shadowValidations.increment();
    if (!success) shadowValidationFailures.increment();
  }

  public void recordError(String type) {
    errorsByType.computeIfAbsent(type, k -> new LongAdder()).increment();
  }

  public void recordLatency(double seconds) {
    latencyBuckets.get("+Inf").incrementAndGet();
    for (double bound : latencyBucketBounds) {
      if (seconds <= bound) latencyBuckets.get(bound + "").incrementAndGet();
    }
  }

  public void setActiveSessions(long count) {
    activeSessions.set(count);
  }

  public void setMcpServersActive(long count) {
    mcpServersActive.set(count);
  }

  private void appendMetric(StringBuilder sb, String name, String type, String help, long value) {
    sb.append("# HELP ").append(name).append(" ").append(help).append("\n");
    sb.append("# TYPE ").append(name).append(" ").append(type).append("\n");
    sb.append(name).append(" ").append(value).append("\n");
  }
}
