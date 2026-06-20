package io.codepilot.core.deploy;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

/**
 * On SIGTERM / context shutdown, drain in-flight runs before the JVM exits. High phase value =
 * stops early in the shutdown sequence.
 */
@Component
@ConditionalOnProperty(
    prefix = "codepilot.deploy.drain",
    name = "shutdown-auto-drain",
    havingValue = "true",
    matchIfMissing = true)
public class DeployDrainShutdownHook implements SmartLifecycle {

  private static final Logger log = LoggerFactory.getLogger(DeployDrainShutdownHook.class);

  private final DeployDrainProperties properties;
  private final DeployDrainService drainService;
  private volatile boolean running = true;

  public DeployDrainShutdownHook(
      DeployDrainProperties properties, DeployDrainService drainService) {
    this.properties = properties;
    this.drainService = drainService;
  }

  @Override
  public void start() {
    running = true;
  }

  @Override
  public void stop() {
    if (!properties.isEnabled() || !properties.isShutdownAutoDrain()) {
      running = false;
      return;
    }
    log.info("Shutdown hook: starting deploy drain");
    try {
      drainService.beginDrain(properties.getShutdownTimeout()).block();
    } catch (Exception e) {
      log.warn("Deploy drain on shutdown failed: {}", e.getMessage());
    }
    running = false;
  }

  @Override
  public boolean isRunning() {
    return running;
  }

  @Override
  public int getPhase() {
    return Integer.MAX_VALUE;
  }
}
