package io.codepilot.core.deploy;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Tracks in-flight conversation SSE runs on this JVM (sessionId → run kind). */
@Component
public class RunLifecycleRegistry {

  private static final Logger log = LoggerFactory.getLogger(RunLifecycleRegistry.class);

  private final ConcurrentHashMap<String, String> activeSessions = new ConcurrentHashMap<>();

  public RunLifecycleRegistry() {}

  /**
   * Registers a new run for the session. If another run is already active, publishes a cluster-wide
   * stop so the previous graph/SSE stream can terminate (on this or another replica).
   */
  public void register(String sessionId, String runKind) {
    if (sessionId == null || sessionId.isBlank()) {
      return;
    }
    String kind = runKind != null ? runKind : "run";
    String previous = activeSessions.put(sessionId, kind);
    if (previous != null) {
      log.info("RunLifecycleRegistry: superseding active {} for session={}", previous, sessionId);
    }
  }

  public void unregister(String sessionId) {
    if (sessionId == null || sessionId.isBlank()) {
      return;
    }
    activeSessions.remove(sessionId);
  }

  public int activeCount() {
    return activeSessions.size();
  }

  public Set<String> activeSessionIds() {
    return Set.copyOf(activeSessions.keySet());
  }
}
