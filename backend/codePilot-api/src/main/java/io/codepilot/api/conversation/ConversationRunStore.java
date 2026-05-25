package io.codepilot.api.conversation;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.core.dto.ConversationRunRequest;
import io.codepilot.core.run.ConversationRunStatus;
import jakarta.annotation.PostConstruct;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Durable conversation run registry + event log (Flyway V10).
 */
@Component
public class ConversationRunStore {

  private static final Logger log = LoggerFactory.getLogger(ConversationRunStore.class);

  private final ObjectMapper mapper;
  private final NamedParameterJdbcTemplate jdbc;
  private final String persistenceMode;
  private volatile boolean dbActive;

  public ConversationRunStore(
      ObjectMapper mapper,
      NamedParameterJdbcTemplate jdbc,
      @Value("${codepilot.conversation.queue.persistence:auto}") String persistenceMode) {
    this.mapper = mapper;
    this.jdbc = jdbc;
    this.persistenceMode = persistenceMode != null ? persistenceMode.trim().toLowerCase() : "auto";
  }

  @PostConstruct
  void init() {
    if ("file".equals(persistenceMode)) {
      dbActive = false;
      log.info("Conversation run queue: disabled (persistence=file)");
      return;
    }
    dbActive = probeDb();
    log.info("Conversation run queue persistence: {}", dbActive ? "database" : "unavailable");
  }

  public boolean isDbBacked() {
    return dbActive;
  }

  public void insertRun(
      String runId,
      String sessionId,
      String userId,
      String requestJson,
      String status) {
    if (!dbActive) return;
    jdbc.update(
        """
        INSERT INTO conversation_runs (
            id, session_id, user_id, status, request_json, last_seq, created_at, updated_at)
        VALUES (
            :id, :sessionId, :userId, :status, :requestJson, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        """,
        new MapSqlParameterSource()
            .addValue("id", runId)
            .addValue("sessionId", sessionId)
            .addValue("userId", userId)
            .addValue("status", status)
            .addValue("requestJson", requestJson));
  }

  public Optional<RunRow> get(String runId) {
    if (!dbActive) return Optional.empty();
    var rows =
        jdbc.query(
            """
            SELECT id, session_id, user_id, status, request_json, continuation_token,
                   worker_id, lease_until, last_seq, error_message
            FROM conversation_runs WHERE id = :id
            """,
            Map.of("id", runId),
            this::mapRunRow);
    return rows.stream().findFirst();
  }

  public List<RunRow> findReclaimable(Instant leaseCutoff, Instant interruptedSince, int limit) {
    if (!dbActive) return List.of();
    return jdbc.query(
        """
        SELECT id, session_id, user_id, status, request_json, continuation_token,
               worker_id, lease_until, last_seq, error_message
        FROM conversation_runs
        WHERE status = 'queued'
           OR (status = 'interrupted' AND updated_at >= :interruptedSince)
           OR (status = 'running' AND (lease_until IS NULL OR lease_until < :cutoff))
        ORDER BY updated_at ASC
        LIMIT :limit
        """,
        new MapSqlParameterSource()
            .addValue("cutoff", Timestamp.from(leaseCutoff))
            .addValue("interruptedSince", Timestamp.from(interruptedSince))
            .addValue("limit", limit),
        this::mapRunRow);
  }

  public boolean tryClaim(String runId, String workerId, Instant leaseUntil) {
    if (!dbActive) return false;
    int updated =
        jdbc.update(
            """
            UPDATE conversation_runs
            SET status = 'running', worker_id = :workerId, lease_until = :leaseUntil,
                updated_at = CURRENT_TIMESTAMP(3)
            WHERE id = :id
              AND (
                status IN ('queued', 'interrupted')
                OR (status = 'running' AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP(3)))
              )
            """,
            new MapSqlParameterSource()
                .addValue("id", runId)
                .addValue("workerId", workerId)
                .addValue("leaseUntil", Timestamp.from(leaseUntil)));
    return updated > 0;
  }

  public void renewLease(String runId, String workerId, Instant leaseUntil) {
    if (!dbActive) return;
    jdbc.update(
        """
        UPDATE conversation_runs
        SET lease_until = :leaseUntil, updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = :id AND worker_id = :workerId AND status = 'running'
        """,
        new MapSqlParameterSource()
            .addValue("id", runId)
            .addValue("workerId", workerId)
            .addValue("leaseUntil", Timestamp.from(leaseUntil)));
  }

  public void markInterrupted(String runId, String continuationToken) {
    if (!dbActive) return;
    jdbc.update(
        """
        UPDATE conversation_runs
        SET status = 'interrupted', worker_id = NULL, lease_until = NULL,
            continuation_token = COALESCE(:token, continuation_token),
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = :id AND status IN ('running', 'queued', 'awaiting_input')
        """,
        new MapSqlParameterSource()
            .addValue("id", runId)
            .addValue("token", continuationToken));
  }

  public void markInterruptedByWorker(String workerId) {
    if (!dbActive) return;
    int n =
        jdbc.update(
            """
            UPDATE conversation_runs
            SET status = 'interrupted', worker_id = NULL, lease_until = NULL,
                updated_at = CURRENT_TIMESTAMP(3)
            WHERE worker_id = :workerId AND status IN ('running', 'queued', 'awaiting_input')
            """,
            Map.of("workerId", workerId));
    if (n > 0) {
      log.info("Marked {} conversation runs interrupted for workerId={}", n, workerId);
    }
  }

  public void updateStatus(String runId, String status, String continuationToken) {
    if (!dbActive) return;
    var params =
        new MapSqlParameterSource()
            .addValue("id", runId)
            .addValue("status", status)
            .addValue("token", continuationToken);
    if (ConversationRunStatus.COMPLETED.equals(status)
        || ConversationRunStatus.FAILED.equals(status)
        || ConversationRunStatus.CANCELLED.equals(status)) {
      jdbc.update(
          """
          UPDATE conversation_runs
          SET status = :status, continuation_token = COALESCE(:token, continuation_token),
              worker_id = NULL, lease_until = NULL, ended_at = CURRENT_TIMESTAMP(3),
              updated_at = CURRENT_TIMESTAMP(3)
          WHERE id = :id
          """,
          params);
    } else {
      jdbc.update(
          """
          UPDATE conversation_runs
          SET status = :status, continuation_token = COALESCE(:token, continuation_token),
              updated_at = CURRENT_TIMESTAMP(3)
          WHERE id = :id
          """,
          params);
    }
  }

  public void fail(String runId, String message) {
    if (!dbActive) return;
    jdbc.update(
        """
        UPDATE conversation_runs
        SET status = 'failed', error_message = :msg, worker_id = NULL, lease_until = NULL,
            ended_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = :id
        """,
        new MapSqlParameterSource().addValue("id", runId).addValue("msg", truncate(message, 1000)));
  }

  public int appendEvent(String runId, int seq, ServerSentEvent<String> event) {
    if (!dbActive) return seq;
    String payload = event.data() != null ? event.data() : "{}";
    String eventName = event.event() != null ? event.event() : "message";
    jdbc.update(
        """
        INSERT INTO conversation_run_events (run_id, seq, event_name, payload_json)
        VALUES (:runId, :seq, :eventName, :payload)
        """,
        new MapSqlParameterSource()
            .addValue("runId", runId)
            .addValue("seq", seq)
            .addValue("eventName", eventName)
            .addValue("payload", payload));
    jdbc.update(
        "UPDATE conversation_runs SET last_seq = :seq, updated_at = CURRENT_TIMESTAMP(3) WHERE id = :id",
        Map.of("id", runId, "seq", seq));
    return seq;
  }

  public List<RunEvent> loadEventRecordsSince(String runId, int afterSeq) {
    if (!dbActive) return List.of();
    return jdbc.query(
        """
        SELECT seq, event_name, payload_json FROM conversation_run_events
        WHERE run_id = :runId AND seq > :afterSeq
        ORDER BY seq ASC
        """,
        Map.of("runId", runId, "afterSeq", afterSeq),
        (rs, rowNum) ->
            new RunEvent(
                rs.getInt("seq"),
                rs.getString("event_name"),
                rs.getString("payload_json")));
  }

  public List<ServerSentEvent<String>> loadEventsSince(String runId, int afterSeq) {
    return loadEventRecordsSince(runId, afterSeq).stream().map(RunEvent::toSse).toList();
  }

  /**
   * Counts runs that currently hold admission slots (queued + actively leased running +
   * awaiting_input).
   */
  public AdmissionDbSnapshot countAdmissionSnapshot() {
    if (!dbActive) {
      return new AdmissionDbSnapshot(0, 0, List.of());
    }
    long globalQueued =
        jdbc.queryForObject(
            "SELECT COUNT(*) FROM conversation_runs WHERE status = 'queued'", Map.of(), Long.class);
    long globalRunning =
        jdbc.queryForObject(
            """
            SELECT COUNT(*) FROM conversation_runs
            WHERE status = 'awaiting_input'
               OR (status = 'running'
                   AND (lease_until IS NULL OR lease_until >= CURRENT_TIMESTAMP(3)))
            """,
            Map.of(),
            Long.class);
    List<UserAdmissionCounts> perUser =
        jdbc.query(
            """
            SELECT user_id,
                   SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
                   SUM(
                     CASE
                       WHEN status = 'awaiting_input' THEN 1
                       WHEN status = 'running'
                            AND (lease_until IS NULL OR lease_until >= CURRENT_TIMESTAMP(3))
                       THEN 1
                       ELSE 0
                     END
                   ) AS running
            FROM conversation_runs
            WHERE status IN ('queued', 'running', 'awaiting_input')
            GROUP BY user_id
            """,
            Map.of(),
            (rs, rowNum) ->
                new UserAdmissionCounts(
                    rs.getString("user_id"),
                    rs.getLong("queued"),
                    rs.getLong("running")));
    return new AdmissionDbSnapshot(globalQueued, globalRunning, perUser);
  }

  /**
   * Mark all stale-lease running runs as interrupted so the plugin can resume them on attach.
   *
   * <p>Uses a <b>find-then-update-one-by-one</b> strategy instead of a single bulk UPDATE
   * to avoid InnoDB deadlocks.  A bulk UPDATE on {@code WHERE status='running' AND lease_until < :cutoff}
   * can acquire row locks in one order while concurrent operations ({@link #tryClaim},
   * {@link #renewLease}, {@link #markInterrupted}) acquire locks on the same rows in a different
   * order, producing a deadlock cycle.
   *
   * <p>By first SELECTing the candidate run IDs (lock-free snapshot read) and then UPDATEing
   * each one individually with a narrow {@code WHERE id = :id AND status = 'running'} condition,
   * we limit each transaction to a single row lock and eliminate the deadlock window.
   * Individual UPDATE failures (row changed between SELECT and UPDATE) are silently tolerated
   * because the run is no longer stale in its current state.
   */
  public int markStaleRunningInterrupted(Instant leaseCutoff) {
    if (!dbActive) return 0;

    // Step 1: Find stale-lease run IDs (non-locking read — no row locks acquired)
    List<String> staleRunIds =
        jdbc.queryForList(
            """
            SELECT id FROM conversation_runs
            WHERE status = 'running' AND (lease_until IS NULL OR lease_until < :cutoff)
            """,
            new MapSqlParameterSource()
                .addValue("cutoff", Timestamp.from(leaseCutoff)),
            String.class);

    if (staleRunIds.isEmpty()) return 0;

    // Step 2: UPDATE each run individually — single row lock per statement, no deadlock window
    int marked = 0;
    for (String runId : staleRunIds) {
      try {
        int updated =
            jdbc.update(
                """
                UPDATE conversation_runs
                SET status = 'interrupted', worker_id = NULL, lease_until = NULL,
                    updated_at = CURRENT_TIMESTAMP(3)
                WHERE id = :id AND status = 'running'
                """,
                new MapSqlParameterSource()
                    .addValue("id", runId));
        marked += updated;
      } catch (DataAccessException e) {
        // Concurrent modification or transient error — skip this row; it will be
        // retried on the next reclaim cycle if still stale.
        log.debug("markStaleRunningInterrupted: skipped runId={} due to concurrent modification", runId);
      }
    }

    if (marked > 0) {
      log.info("Marked {} stale-lease running runs as interrupted (leaseCutoff={})", marked, leaseCutoff);
    }
    return marked;
  }

  public Map<String, Object> statusMap(String runId) {
    return get(runId)
        .map(
            r -> {
              Map<String, Object> m = new LinkedHashMap<>();
              m.put("runId", r.id());
              m.put("sessionId", r.sessionId());
              m.put("status", r.status());
              m.put("lastSeq", r.lastSeq());
              m.put("continuationToken", r.continuationToken());
              m.put("workerId", r.workerId());
              return m;
            })
        .orElse(Map.of("runId", runId, "status", "not_found"));
  }

  public String serializeRequest(ConversationRunRequest req) {
    try {
      return mapper.writeValueAsString(req);
    } catch (Exception e) {
      throw new IllegalStateException("Failed to serialize run request", e);
    }
  }

  public ConversationRunRequest deserializeRequest(String json) {
    try {
      return mapper.readValue(json, ConversationRunRequest.class);
    } catch (Exception e) {
      throw new IllegalStateException("Failed to deserialize run request", e);
    }
  }

  private boolean probeDb() {
    if ("file".equals(persistenceMode)) return false;
    try {
      jdbc.queryForObject("SELECT COUNT(*) FROM conversation_runs", Map.of(), Integer.class);
      return true;
    } catch (DataAccessException e) {
      return false;
    }
  }

  private RunRow mapRunRow(ResultSet rs, int rowNum) throws SQLException {
    Timestamp lease = rs.getTimestamp("lease_until");
    return new RunRow(
        rs.getString("id"),
        rs.getString("session_id"),
        rs.getString("user_id"),
        rs.getString("status"),
        rs.getString("request_json"),
        rs.getString("continuation_token"),
        rs.getString("worker_id"),
        lease != null ? lease.toInstant() : null,
        rs.getInt("last_seq"),
        rs.getString("error_message"));
  }

  private static String truncate(String s, int max) {
    if (s == null) return null;
    return s.length() <= max ? s : s.substring(0, max);
  }

  public record RunEvent(int seq, String eventName, String payloadJson) {
    public ServerSentEvent<String> toSse() {
      return ServerSentEvent.<String>builder().event(eventName).data(payloadJson).build();
    }
  }

  public record AdmissionDbSnapshot(long globalQueued, long globalRunning, List<UserAdmissionCounts> perUser) {}

  public record UserAdmissionCounts(String userId, long queued, long running) {}

  public record RunRow(
      String id,
      String sessionId,
      String userId,
      String status,
      String requestJson,
      String continuationToken,
      String workerId,
      Instant leaseUntil,
      int lastSeq,
      String errorMessage) {}
}
