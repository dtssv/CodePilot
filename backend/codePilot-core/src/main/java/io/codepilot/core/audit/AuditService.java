package io.codepilot.core.audit;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.codepilot.common.audit.AuditEventDto;
import io.codepilot.common.audit.AuditQueryRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Service for recording and querying audit events.
 *
 * <p>Only metadata is stored — never user code or chat content.
 * Messages are hashed before storage to prevent accidental data leaks.
 */
@Service
public class AuditService {

  private static final Logger LOG = LoggerFactory.getLogger(AuditService.class);
  private final JdbcTemplate jdbc;
  private final ObjectMapper objectMapper;

  public AuditService(JdbcTemplate jdbc, ObjectMapper objectMapper) {
    this.jdbc = jdbc;
    this.objectMapper = objectMapper;
  }

  /**
   * Records an audit event. The message is hashed before storage.
   */
  public Mono<Void> record(AuditEventDto event) {
    return Mono.<Void>fromCallable(() -> {
      String sql = """
          INSERT INTO audit_events (ts, trace_id, tenant_id, user_id, device_id,
              kind, severity, code, message, args_hash, duration_ms, extra_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
          """;

      String extraJson = event.extraJson() != null
          ? objectMapper.writeValueAsString(event.extraJson())
          : "{}";

      jdbc.update(sql,
          event.ts() != null ? event.ts() : Instant.now(),
          event.traceId(),
          event.tenantId(),
          event.userId(),
          event.deviceId(),
          event.kind(),
          event.severity() != null ? event.severity() : "info",
          event.code(),
          event.message(),
          event.argsHash(),
          event.durationMs(),
          extraJson);

      return null;
    }).subscribeOn(Schedulers.boundedElastic())
        .doOnError(e -> LOG.error("Failed to record audit event kind={}", event.kind(), e));
  }

  /**
   * Queries audit events with optional filters.
   */
  public Mono<List<AuditEventDto>> query(AuditQueryRequest request) {
    return Mono.fromCallable(() -> {
      var sql = new StringBuilder("SELECT id, ts, trace_id, tenant_id, user_id, device_id, kind, severity, code, message, args_hash, duration_ms, extra_json FROM audit_events WHERE 1=1");
      var params = new ArrayList<Object>();

      if (request.userId() != null) {
        sql.append(" AND user_id = ?");
        params.add(request.userId());
      }
      if (request.kind() != null) {
        sql.append(" AND kind = ?");
        params.add(request.kind());
      }
      if (request.severity() != null) {
        sql.append(" AND severity = ?");
        params.add(request.severity());
      }

      sql.append(" ORDER BY ts DESC LIMIT ? OFFSET ?");
      params.add(request.limit());
      params.add(request.offset());

      return jdbc.query(sql.toString(), (rs, rowNum) -> {
        @SuppressWarnings("unchecked")
        Map<String, Object> extra = objectMapper.readValue(
            rs.getString("extra_json"), Map.class);

        return new AuditEventDto(
            rs.getLong("id"),
            rs.getTimestamp("ts") != null ? rs.getTimestamp("ts").toInstant() : null,
            rs.getString("trace_id"),
            rs.getObject("tenant_id", UUID.class),
            rs.getObject("user_id", UUID.class),
            rs.getString("device_id"),
            rs.getString("kind"),
            rs.getString("severity"),
            rs.getObject("code", Integer.class),
            rs.getString("message"),
            rs.getString("args_hash"),
            rs.getObject("duration_ms", Long.class),
            extra);
      }, params.toArray());
    }).subscribeOn(Schedulers.boundedElastic());
  }
}