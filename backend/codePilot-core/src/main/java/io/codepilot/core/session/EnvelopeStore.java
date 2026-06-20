package io.codepilot.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Durable store for envelope events, enabling stream replay for reconnections.
 *
 * <p>When a client reconnects, envelopes are replayed from the DB.
 */
@Component
public class EnvelopeStore {

  private static final Logger log = LoggerFactory.getLogger(EnvelopeStore.class);

  /**
   * Cap on the persisted {@code payload_json} size. Envelopes only back reconnect/replay, so an
   * oversized payload is stored as a compact truncation marker instead of attempting an INSERT that
   * could exceed MySQL's {@code max_allowed_packet} and break the connection. Kept well under common
   * 4 MB server limits even at UTF-8 worst case.
   */
  private static final int MAX_PAYLOAD_CHARS = 256 * 1024;

  private final JdbcTemplate jdbc;
  private final ObjectMapper mapper =
      new ObjectMapper()
          .findAndRegisterModules()
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

  /**
   * Dedicated executor for durable persistence. Writes are offloaded here so a blocking JDBC call
   * is never run on the reactive SSE worker thread — otherwise cancelling the stream (client
   * disconnect) interrupts the worker mid-socket-read, yielding "Closed by interrupt" and a broken
   * pooled connection. Bounded queue + discard policy keeps persistence best-effort under load.
   */
  private final ThreadPoolExecutor persistExecutor =
      new ThreadPoolExecutor(
          2,
          2,
          30,
          TimeUnit.SECONDS,
          new ArrayBlockingQueue<>(20_000),
          r -> {
            Thread t = new Thread(r, "envelope-persist-" + PERSIST_THREAD_SEQ.incrementAndGet());
            t.setDaemon(true);
            return t;
          },
          new ThreadPoolExecutor.DiscardPolicy());

  private static final AtomicInteger PERSIST_THREAD_SEQ = new AtomicInteger();

  public EnvelopeStore(DataSource dataSource) {
    this.jdbc = new JdbcTemplate(dataSource);
    this.persistExecutor.allowCoreThreadTimeOut(true);
  }

  @PreDestroy
  void shutdown() {
    persistExecutor.shutdown();
    try {
      if (!persistExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
        persistExecutor.shutdownNow();
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      persistExecutor.shutdownNow();
    }
  }

  /** Persist an envelope durably. Non-blocking and best-effort: the write runs on a dedicated
   * executor so it never blocks or is interrupted by the live SSE stream. */
  public void save(String sessionId, EnvelopeEvent event) {
    try {
      persistExecutor.execute(() -> doSave(sessionId, event));
    } catch (Exception e) {
      // Rejected (executor shutting down) — drop silently; replay is best-effort.
      log.debug("Envelope persist rejected for session {}: {}", sessionId, e.getMessage());
    }
  }

  private void doSave(String sessionId, EnvelopeEvent event) {
    try {
      String payloadJson = mapper.writeValueAsString(event.payload());
      if (payloadJson != null && payloadJson.length() > MAX_PAYLOAD_CHARS) {
        log.debug(
            "Envelope seq={} for session {} payload too large ({} chars); storing truncation marker",
            event.seq(),
            sessionId,
            payloadJson.length());
        payloadJson =
            "{\"truncated\":true,\"originalChars\":"
                + payloadJson.length()
                + ",\"type\":"
                + mapper.writeValueAsString(event.type())
                + "}";
      }
      jdbc.update(
          "INSERT INTO agent_envelopes (session_id, seq, turn_id, step_id, type, payload_json, ts) "
              + "VALUES (?,?,?,?,?,?,?) "
              + "ON DUPLICATE KEY UPDATE payload_json=?",
          sessionId,
          event.seq(),
          event.turnId(),
          event.stepId(),
          event.type(),
          payloadJson,
          event.ts(),
          payloadJson);
    } catch (Exception e) {
      // Durable persistence is best-effort; a failure here must never break the live SSE stream.
      log.warn(
          "Failed to save envelope seq={} for session {}: {}",
          event.seq(),
          sessionId,
          e.getMessage());
    }
  }

  public List<EnvelopeEvent> loadAfter(String sessionId, int afterSeq) {
    try {
      List<Map<String, Object>> rows =
          jdbc.queryForList(
              "SELECT * FROM agent_envelopes WHERE session_id = ? AND seq > ? ORDER BY seq",
              sessionId,
              afterSeq);
      List<EnvelopeEvent> result = new ArrayList<>();
      for (var row : rows) {
        Object payloadObj = row.get("payload_json");
        String payloadJson = payloadObj != null ? payloadObj.toString() : "{}";
        @SuppressWarnings("unchecked")
        Map<String, Object> payload =
            (Map<String, Object>) mapper.readValue(payloadJson, Map.class);
        result.add(
            new EnvelopeEvent(
                (int) row.get("seq"),
                (String) row.get("turn_id"),
                (String) row.get("step_id"),
                null, // parentStepId not stored separately
                (long) row.get("ts"),
                (String) row.get("type"),
                payload));
      }
      return result;
    } catch (Exception e) {
      log.warn("Failed to load envelopes for session {}", sessionId, e);
      return List.of();
    }
  }
}
