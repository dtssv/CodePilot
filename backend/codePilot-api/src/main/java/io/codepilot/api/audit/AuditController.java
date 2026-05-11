package io.codepilot.api.audit;

import io.codepilot.common.api.ApiResponse;
import io.codepilot.core.audit.AuditRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Audit endpoints: client event submission + self-query. */
@Tag(name = "audit", description = "Audit event submission and query")
@RestController
@RequestMapping(value = "/v1/audit", produces = MediaType.APPLICATION_JSON_VALUE)
public class AuditController {

  private final AuditRepository auditRepo;
  private final NamedParameterJdbcTemplate jdbc;

  public AuditController(AuditRepository auditRepo, NamedParameterJdbcTemplate jdbc) {
    this.auditRepo = auditRepo;
    this.jdbc = jdbc;
  }

  /** Plugin-initiated audit event (metadata only, no user code). */
  @Operation(summary = "Submit an audit event from the plugin")
  @PostMapping(value = "/event", consumes = MediaType.APPLICATION_JSON_VALUE)
  public ApiResponse<Map<String, Boolean>> submitEvent(
      @RequestHeader(value = "X-User-Id", required = false) String userId,
      @RequestHeader(value = "X-CodePilot-Device-Id", required = false) String deviceId,
      @RequestBody @Valid AuditEventRequest req) {
    var extra = req.extra() != null ? new java.util.LinkedHashMap<>(req.extra()) : new java.util.LinkedHashMap<String, Object>();
    if (req.argsHash() != null) extra.put("argsHash", req.argsHash());
    if (req.durationMs() != null) extra.put("durationMs", req.durationMs());
    auditRepo.insert(null, null, userId, deviceId, req.type(), "info", null, null, null, null, extra);
    return ApiResponse.ok(Map.of("accepted", true));
  }

  /** Query own audit records. */
  @Operation(summary = "Query current user's audit events")
  @GetMapping("/me")
  public ApiResponse<Object> queryMine(
      @RequestHeader("X-User-Id") String userId,
      @RequestParam(defaultValue = "50") int limit) {
    String sql = "SELECT ts, kind, severity, message, extra_json FROM audit_events WHERE user_id = cast(:uid as uuid) ORDER BY ts DESC LIMIT :limit";
    var rows = jdbc.queryForList(sql, new MapSqlParameterSource().addValue("uid", userId).addValue("limit", limit));
    return ApiResponse.ok(rows);
  }

  public record AuditEventRequest(
      @NotBlank String type, String argsHash, Integer durationMs, Map<String, Object> extra) {}
}