package io.codepilot.core.deploy;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.ReactiveHealthIndicator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/** Removes pod from readiness while draining so the Service stops sending new traffic. */
@Component("deployDrain")
@ConditionalOnProperty(
    prefix = "codepilot.deploy.drain",
    name = "enabled",
    havingValue = "true",
    matchIfMissing = true)
public class DeployDrainHealthIndicator implements ReactiveHealthIndicator {

  private final DeployDrainService drainService;
  private final RunLifecycleRegistry registry;

  public DeployDrainHealthIndicator(
      DeployDrainService drainService, RunLifecycleRegistry registry) {
    this.drainService = drainService;
    this.registry = registry;
  }

  @Override
  public Mono<Health> health() {
    if (drainService.shouldMarkReadinessDown()) {
      return Mono.just(
          Health.outOfService()
              .withDetail("draining", true)
              .withDetail("activeRuns", registry.activeCount())
              .build());
    }
    return Mono.just(
        Health.up()
            .withDetail("draining", false)
            .withDetail("activeRuns", registry.activeCount())
            .build());
  }
}
