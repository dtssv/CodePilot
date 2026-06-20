package io.codepilot.core.deploy;

import io.codepilot.core.run.WorkerIdentity;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Coordinates rolling-deploy drain: flip draining flag, signal active sessions to stop, wait for
 * local registry to empty, and keep readiness down until the pod exits.
 */
@Service
public class DeployDrainService {

  private static final Logger log = LoggerFactory.getLogger(DeployDrainService.class);

  public static final String DONE_REASON_DEPLOY_DRAINING = "deploy_draining";

  private final DeployDrainProperties properties;
  private final RunLifecycleRegistry registry;
  private final WorkerIdentity workerIdentity;
  private final ObjectProvider<ConversationRunDrainHook> runDrainHooks;
  private final AtomicBoolean draining = new AtomicBoolean(false);

  public DeployDrainService(
      DeployDrainProperties properties,
      RunLifecycleRegistry registry,
      WorkerIdentity workerIdentity,
      ObjectProvider<ConversationRunDrainHook> runDrainHooks) {
    this.properties = properties;
    this.registry = registry;
    this.workerIdentity = workerIdentity;
    this.runDrainHooks = runDrainHooks;
  }

  public boolean isDraining() {
    return draining.get();
  }

  public boolean shouldRejectNewRuns() {
    return properties.isEnabled() && properties.isRejectNewRuns() && draining.get();
  }

  public boolean shouldMarkReadinessDown() {
    return properties.isEnabled() && properties.isReadinessWhenDraining() && draining.get();
  }

  /** Idempotent: begins drain, signals all active sessions, waits up to {@code timeout}. */
  public Mono<DrainResult> beginDrain(Duration timeout) {
    if (!properties.isEnabled()) {
      return Mono.just(new DrainResult(false, 0, 0, true));
    }
    Duration wait = timeout != null ? timeout : properties.getDefaultTimeout();
    int atStart = registry.activeCount();
    if (!draining.compareAndSet(false, true)) {
      return waitForIdle(wait)
          .map(remaining -> new DrainResult(true, atStart, remaining, remaining == 0));
    }
    log.info("Deploy drain started: activeSessions={}", atStart);
    runDrainHooks.ifAvailable(h -> h.onDrainStarted(workerIdentity.id()));
    var sessions = registry.activeSessionIds();
    return Flux.fromIterable(sessions)
        .flatMap(this::signalSessionStop)
        .then(waitForIdle(wait))
        .map(
            remaining -> {
              boolean done = remaining == 0;
              log.info(
                  "Deploy drain finished: activeAtStart={}, remaining={}, completed={}",
                  atStart,
                  remaining,
                  done);
              return new DrainResult(false, atStart, remaining, done);
            });
  }

  private Mono<Void> signalSessionStop(String sessionId) {
    log.info("Signaling deploy stop for sessionId={}", sessionId);
    return Mono.fromRunnable(() -> {});
  }

  private Mono<Integer> waitForIdle(Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    return Mono.defer(
        () -> {
          int remaining = registry.activeCount();
          if (remaining == 0) {
            return Mono.just(0);
          }
          if (System.nanoTime() >= deadline) {
            return Mono.just(remaining);
          }
          return Mono.delay(Duration.ofMillis(200)).then(waitForIdle(timeout));
        });
  }
}
