package io.codepilot.mcp.audit;

import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Insert-only helper for the {@code system_leak_events} table. Callers MUST supply a short
 * redacted excerpt (<=200 chars); never pass raw prompt contents.
 */
@Repository
public class SystemLeakRepository {

  private final NamedParameterJdbcTemplate jdbc;

  public SystemLeakRepository(NamedParameterJdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public void insert(
      String traceId,
      String userId,
      String modelName,
      String phase,
      String matchedRule,
      String matchedHash,
      String sampleExcerpt) {
    String sql =
        """
        INSERT INTO system_leak_events(trace_id, user_id, model_name, phase, matched_rule,
                                        matched_hash, sample_excerpt)
        VALUES (:trace_id, :user_id, :model_name, :phase, :matched_rule,
                 :matched_hash, :sample_excerpt)
        """;
    var params = new MapSqlParameterSource()
        .addValue("trace_id", traceId)
        .addValue("user_id", userId)
        .addValue("model_name", modelName)
        .addValue("phase", phase)
        .addValue("matched_rule", matchedRule)
        .addValue("matched_hash", matchedHash)
        .addValue(
            "sample_excerpt",
            sampleExcerpt == null ? null : sampleExcerpt.substring(0, Math.min(200, sampleExcerpt.length())));
    jdbc.update(sql, params);
  }
}