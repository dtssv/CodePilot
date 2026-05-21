package io.codepilot.core.run;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Tuning for {@link io.codepilot.core.graph.GraphEngineService} thread pool (cluster scale-out). */
@ConfigurationProperties(prefix = "codepilot.graph")
public class GraphEngineProperties {

  /**
   * Max threads for graph-engine bounded elastic scheduler. 0 uses Reactor default
   * ({@code 10 * CPUs}).
   */
  private int schedulerThreadCap = 0;

  /** Queue size for graph-engine scheduler. 0 uses Reactor default (100_000). */
  private int schedulerQueueSize = 0;

  public int getSchedulerThreadCap() {
    return schedulerThreadCap;
  }

  public void setSchedulerThreadCap(int schedulerThreadCap) {
    this.schedulerThreadCap = schedulerThreadCap;
  }

  public int getSchedulerQueueSize() {
    return schedulerQueueSize;
  }

  public void setSchedulerQueueSize(int schedulerQueueSize) {
    this.schedulerQueueSize = schedulerQueueSize;
  }
}
