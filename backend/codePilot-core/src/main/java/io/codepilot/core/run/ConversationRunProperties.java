package io.codepilot.core.run;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Durable conversation run queue (P2b). */
@ConfigurationProperties(prefix = "codepilot.conversation.queue")
public class ConversationRunProperties {

  /** auto | true | false — auto enables when {@code conversation_runs} table exists. */
  private String enabled = "auto";

  /** Only agent + graph engine runs use the queue (chat stays inline SSE). */
  private boolean agentOnly = true;

  private Duration leaseDuration = Duration.ofMinutes(2);

  private Duration reclaimInterval = Duration.ofSeconds(30);

  private Duration staleLeaseGrace = Duration.ofSeconds(15);

  public String getEnabled() {
    return enabled;
  }

  public void setEnabled(String enabled) {
    this.enabled = enabled;
  }

  public boolean isAgentOnly() {
    return agentOnly;
  }

  public void setAgentOnly(boolean agentOnly) {
    this.agentOnly = agentOnly;
  }

  public Duration getLeaseDuration() {
    return leaseDuration;
  }

  public void setLeaseDuration(Duration leaseDuration) {
    this.leaseDuration = leaseDuration;
  }

  public Duration getReclaimInterval() {
    return reclaimInterval;
  }

  public void setReclaimInterval(Duration reclaimInterval) {
    this.reclaimInterval = reclaimInterval;
  }

  public Duration getStaleLeaseGrace() {
    return staleLeaseGrace;
  }

  public void setStaleLeaseGrace(Duration staleLeaseGrace) {
    this.staleLeaseGrace = staleLeaseGrace;
  }
}
