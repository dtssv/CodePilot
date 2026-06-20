package io.codepilot.mcp.audit;

/**
 * @deprecated Use {@link io.codepilot.core.audit.AuditRepository} instead. This class is kept only
 *     for backward compatibility; it will be removed in a future version.
 */
@Deprecated(forRemoval = true)
public class AuditRepository extends io.codepilot.core.audit.AuditRepository {
  public AuditRepository(
      org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc,
      com.fasterxml.jackson.databind.ObjectMapper mapper) {
    super(jdbc.getJdbcTemplate());
  }
}
