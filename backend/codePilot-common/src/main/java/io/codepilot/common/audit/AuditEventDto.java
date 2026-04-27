package io.codepilot.common.audit;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * DTO for audit events. Only metadata is stored — never user code or chat content.
 *
 * @param id         auto-generated ID
 * @param ts         event timestamp
 * @param traceId    distributed trace ID (for correlation)
 * @param tenantId   tenant ID (multi-tenancy)
 * @param userId     user ID
 * @param deviceId   device identifier
 * @param kind       event kind (e.g. tool_executed, patch_applied, command_blocked)
 * @param severity   info / warn / error
 * @param code       optional numeric code
 * @param message    optional message (hashed in storage)
 * @param argsHash   hash of the arguments (never raw args)
 * @param durationMs duration in milliseconds (for latency tracking)
 * @param extraJson  additional metadata as JSON
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AuditEventDto(
    Long id,
    Instant ts,
    String traceId,
    UUID tenantId,
    UUID userId,
    String deviceId,
    String kind,
    String severity,
    Integer code,
    String message,
    String argsHash,
    Long durationMs,
    Map<String, Object> extraJson
) {}