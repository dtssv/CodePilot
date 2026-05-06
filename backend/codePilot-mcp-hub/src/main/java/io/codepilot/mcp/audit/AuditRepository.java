package io.codepilot.mcp.audit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Small insert-only helper for the {@code audit_events} table. Never stores plaintext user code or
 * credentials; callers should pass hashes instead of raw values.
 */
@Repository
public class AuditRepository {

  private final NamedParameterJdbcTemplate jdbc;
  private final ObjectMapper mapper;

  public AuditRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
  }

  public void insert(
      String traceId,
      String tenantId,
      String userId,
      String deviceId,
      String kind,
      String severity,
      Integer code,
      String message,
      String argsHash,
      Integer durationMs,
      Map<String, Object> extra) {
    String sql =
        """
        INSERT INTO audit_events(trace_id, tenant_id, user_id, device_id, kind, severity, code,
                                  message, args_hash, duration_ms, extra_json)
        VALUES (:trace_id, cast(:tenant_id as uuid), cast(:user_id as uuid), :device_id, :kind,
                 :severity, :code, :message, :args_hash, :duration_ms, cast(:extra as jsonb))
        """;
    var params = new MapSqlParameterSource()
        .addValue("trace_id", traceId)
        .addValue("tenant_id", tenantId)
        .addValue("user_id", userId)
        .addValue("device_id", deviceId)
        .addValue("kind", kind)
        .addValue("severity", severity == null ? "info" : severity)
        .addValue("code", code)
        .addValue("message", message)
        .addValue("args_hash", argsHash)
        .addValue("duration_ms", durationMs)
        .addValue("extra", toJson(extra));
    jdbc.update(sql, params);
  }

  private String toJson(Map<String, Object> extra) {
    if (extra == null) return "{}";
    try {
      return mapper.writeValueAsString(extra);
    } catch (JsonProcessingException e) {
      return "{}";
    }
  }
}