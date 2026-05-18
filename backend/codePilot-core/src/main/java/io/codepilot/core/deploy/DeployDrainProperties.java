package io.codepilot.core.deploy;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Configuration for rolling-deploy drain (stop new runs, wait for in-flight graph/SSE). */
@ConfigurationProperties(prefix = "codepilot.deploy.drain")
public class DeployDrainProperties {

  /** Master switch for drain filter, health contributor, and shutdown hook. */
  private boolean enabled = true;

  /** Begin drain automatically on SIGTERM / context shutdown. */
  private boolean shutdownAutoDrain = true;

  /** Reject new {@code /conversation/run} and {@code /resume} while draining. */
  private boolean rejectNewRuns = true;

  /** Mark readiness OUT_OF_SERVICE for the whole drain window. */
  private boolean readinessWhenDraining = true;

  /** Default max wait for in-flight runs to finish after stop signals. */
  private Duration defaultTimeout = Duration.ofSeconds(55);

  /** Shutdown / preStop timeout (should be &lt; K8s terminationGracePeriodSeconds). */
  private Duration shutdownTimeout = Duration.ofSeconds(55);

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public boolean isShutdownAutoDrain() {
    return shutdownAutoDrain;
  }

  public void setShutdownAutoDrain(boolean shutdownAutoDrain) {
    this.shutdownAutoDrain = shutdownAutoDrain;
  }

  public boolean isRejectNewRuns() {
    return rejectNewRuns;
  }

  public void setRejectNewRuns(boolean rejectNewRuns) {
    this.rejectNewRuns = rejectNewRuns;
  }

  public boolean isReadinessWhenDraining() {
    return readinessWhenDraining;
  }

  public void setReadinessWhenDraining(boolean readinessWhenDraining) {
    this.readinessWhenDraining = readinessWhenDraining;
  }

  public Duration getDefaultTimeout() {
    return defaultTimeout;
  }

  public void setDefaultTimeout(Duration defaultTimeout) {
    this.defaultTimeout = defaultTimeout;
  }

  public Duration getShutdownTimeout() {
    return shutdownTimeout;
  }

  public void setShutdownTimeout(Duration shutdownTimeout) {
    this.shutdownTimeout = shutdownTimeout;
  }
}
