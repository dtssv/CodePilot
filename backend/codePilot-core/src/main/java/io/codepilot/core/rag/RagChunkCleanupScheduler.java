package io.codepilot.core.rag;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Periodically purges expired RAG chunks from the {@code rag_chunks} table. Runs every 15 minutes
 * to ensure stale embeddings are cleaned up promptly, given the 24-hour TTL policy.
 */
@Component
public class RagChunkCleanupScheduler {

  private static final Logger log = LoggerFactory.getLogger(RagChunkCleanupScheduler.class);

  private final RagRepository repository;

  public RagChunkCleanupScheduler(RagRepository repository) {
    this.repository = repository;
  }

  /**
   * Runs every 15 minutes. The fixed-delay approach avoids overlap: the next execution starts 15
   * minutes after the previous one finishes.
   */
  @Scheduled(fixedDelay = 15 * 60 * 1000, initialDelay = 60 * 1000)
  public void cleanupExpiredChunks() {
    try {
      int deleted = repository.deleteExpired();
      if (deleted > 0) {
        log.info("RAG cleanup: deleted {} expired chunks", deleted);
      }
    } catch (Exception ex) {
      log.error("RAG cleanup failed", ex);
    }
  }
}