package io.codepilot.common.audit;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.UUID;

/**
 * Query parameters for audit events.
 *
 * @param userId    filter by user ID (required for user-scoped queries)
 * @param kind      filter by event kind
 * @param severity  filter by severity level
 * @param limit     max results (default 50, max 200)
 * @param offset    pagination offset
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AuditQueryRequest(
    UUID userId,
    String kind,
    String severity,
    Integer limit,
    Integer offset
) {
  public AuditQueryRequest {
    if (limit == null) limit = 50;
    if (limit > 200) limit = 200;
    if (offset == null) offset = 0;
  }
}