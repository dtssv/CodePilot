package io.codepilot.core.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Service;

/**
 * Centralized custom metrics. Exposed via {@code /actuator/prometheus} under the prefix {@code
 * codepilot_*}. These are the "must-have" production observability signals:
 *
 * <ul>
 *   <li>conversation_run — counts + latency per mode
 *   <li>tool_calls — count by name + ok/fail
 *   <li>system_leak_blocked — pre & post
 *   <li>skill_activated — per skill id
 *   <li>auth — logins, refresh, failures
 * </ul>
 */
@Service
public class MetricsService {

  private final MeterRegistry registry;
  private final Counter leakBlockedPre;
  private final Counter leakBlockedPost;

  public MetricsService(MeterRegistry registry) {
    this.registry = registry;
    this.leakBlockedPre =
        Counter.builder("codepilot.system_leak_blocked")
            .tag("phase", "pre")
            .description("Pre-LLM system prompt leak blocks")
            .register(registry);
    this.leakBlockedPost =
        Counter.builder("codepilot.system_leak_blocked")
            .tag("phase", "post")
            .description("Post-LLM system prompt leak blocks")
            .register(registry);
  }

  public Timer.Sample startConversation() {
    return Timer.start(registry);
  }

  public void stopConversation(Timer.Sample sample, String mode, String reason) {
    sample.stop(
        Timer.builder("codepilot.conversation_run")
            .tag("mode", mode)
            .tag("reason", reason)
            .register(registry));
  }

  public void toolCall(String name, boolean ok) {
    Counter.builder("codepilot.tool_calls")
        .tag("tool", name)
        .tag("ok", String.valueOf(ok))
        .register(registry)
        .increment();
  }

  public void leakBlockedPre() {
    leakBlockedPre.increment();
  }

  public void leakBlockedPost() {
    leakBlockedPost.increment();
  }

  public void skillActivated(String id) {
    Counter.builder("codepilot.skill_activated").tag("id", id).register(registry).increment();
  }

  public void authEvent(String event) {
    Counter.builder("codepilot.auth").tag("event", event).register(registry).increment();
  }
}
