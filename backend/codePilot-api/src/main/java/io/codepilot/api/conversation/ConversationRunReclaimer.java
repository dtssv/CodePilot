package io.codepilot.api.conversation;

import io.codepilot.core.run.ConversationRunProperties;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Periodically marks stale-lease running runs as interrupted so the plugin can resume
 * them via {@link ConversationQueuedOrchestrator#attach}. Does NOT auto-resume execution
 * because the plugin may have already started a new task and the server-side execution
 * would be orphaned (wasting resources with no SSE consumer).
 */
@Component
public class ConversationRunReclaimer {

  private static final Logger log = LoggerFactory.getLogger(ConversationRunReclaimer.class);

  private final ConversationRunStore store;
  private final ConversationRunProperties properties;

  public ConversationRunReclaimer(
      ConversationRunStore store,
      ConversationRunProperties properties) {
    this.store = store;
    this.properties = properties;
  }

  @Scheduled(fixedDelayString = "${codepilot.conversation.queue.reclaim-interval-ms:30000}")
  public void reclaim() {
    if (!store.isDbBacked()) return;
    Instant leaseCutoff = Instant.now().minus(properties.getStaleLeaseGrace());
    // Mark stale-lease running runs as interrupted so the plugin can resume them on attach.
    // We intentionally do NOT auto-resume execution here because:
    // 1. The plugin may have already restarted a new task
    // 2. The server-side execution would be orphaned — no SSE consumer connected
    // 3. It wastes LLM tokens and compute resources on "empty runs"
    int marked = store.markStaleRunningInterrupted(leaseCutoff);
    if (marked > 0) {
      log.info("Reclaimer: marked {} stale-lease running runs as interrupted", marked);
    }
  }
}