package io.codepilot.api.conversation;

import io.codepilot.core.run.ConversationRunProperties;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Claims queued / interrupted / stale-lease runs for this worker. */
@Component
public class ConversationRunReclaimer {

  private static final Logger log = LoggerFactory.getLogger(ConversationRunReclaimer.class);

  private final ConversationRunStore store;
  private final ConversationRunWorker worker;
  private final ConversationRunProperties properties;

  public ConversationRunReclaimer(
      ConversationRunStore store,
      ConversationRunWorker worker,
      ConversationRunProperties properties) {
    this.store = store;
    this.worker = worker;
    this.properties = properties;
  }

  @Scheduled(fixedDelayString = "${codepilot.conversation.queue.reclaim-interval-ms:30000}")
  public void reclaim() {
    if (!store.isDbBacked()) return;
    Instant cutoff = Instant.now().minus(properties.getStaleLeaseGrace());
    Instant interruptedSince = Instant.now().minus(properties.getInterruptedReclaimMaxAge());
    List<ConversationRunStore.RunRow> rows =
        store.findReclaimable(cutoff, interruptedSince, properties.getReclaimBatchSize());
    for (var row : rows) {
      if (worker.isExecuting(row.id())) continue;
      log.debug("Reclaim candidate runId={} status={}", row.id(), row.status());
      worker.startIfClaimed(row.id());
    }
  }
}
