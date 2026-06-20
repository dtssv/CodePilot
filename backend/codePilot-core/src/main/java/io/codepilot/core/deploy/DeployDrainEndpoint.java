package io.codepilot.core.deploy;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.actuate.endpoint.annotation.Endpoint;
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation;
import org.springframework.boot.actuate.endpoint.annotation.WriteOperation;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Actuator endpoint used by K8s preStop and bare-metal rollout scripts.
 *
 * <p>{@code POST /actuator/drain} — begin drain; {@code GET /actuator/drain} — status.
 */
@Component
@Endpoint(id = "drain")
@ConditionalOnProperty(
    prefix = "codepilot.deploy.drain",
    name = "enabled",
    havingValue = "true",
    matchIfMissing = true)
public class DeployDrainEndpoint {

  private final DeployDrainService drainService;
  private final RunLifecycleRegistry registry;

  public DeployDrainEndpoint(DeployDrainService drainService, RunLifecycleRegistry registry) {
    this.drainService = drainService;
    this.registry = registry;
  }

  @ReadOperation
  public Map<String, Object> status() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("draining", drainService.isDraining());
    body.put("activeRuns", registry.activeCount());
    body.put("activeSessionIds", registry.activeSessionIds());
    return body;
  }

  @WriteOperation
  public Map<String, Object> drain() {
    DrainResult result =
        drainService.beginDrain(null).blockOptional().orElse(new DrainResult(false, 0, 0, true));
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("draining", drainService.isDraining());
    body.put("alreadyDraining", result.alreadyDraining());
    body.put("activeAtStart", result.activeAtStart());
    body.put("remaining", result.remaining());
    body.put("completedWithinTimeout", result.completedWithinTimeout());
    return body;
  }
}
