package io.codepilot.core.deploy;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/** Tracks in-flight conversation SSE runs on this JVM (sessionId → run kind). */
@Component
public class RunLifecycleRegistry {

  private final ConcurrentHashMap<String, String> activeSessions = new ConcurrentHashMap<>();

  public void register(String sessionId, String runKind) {
    if (sessionId == null || sessionId.isBlank()) {
      return;
    }
    activeSessions.put(sessionId, runKind != null ? runKind : "run");
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
