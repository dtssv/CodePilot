package io.codepilot.api.audit;

import io.codepilot.common.audit.AuditEventDto;
import io.codepilot.common.audit.AuditQueryRequest;
import io.codepilot.core.audit.AuditService;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

/**
 * REST controller for audit events.
 *
 * <p>Endpoints:
 * <ul>
 *   <li>POST /v1/audit/events — Record an audit event</li>
 *   <li>GET  /v1/audit/events — Query audit events (with filters)</li>
 * </ul>
 *
 * <p>Only metadata is stored — never user code or chat content.
 */
@RestController
@RequestMapping("/v1/audit")
public class AuditController {

  private final AuditService auditService;

  public AuditController(AuditService auditService) {
    this.auditService = auditService;
  }

  /**
   * Record an audit event.
   *
   * <p>Typically called by internal services (tool execution, patch application,
   * command blocking, etc.) via the AuditService directly. Exposed as REST
   * for the gateway/plugin to report device-level events.
   */
  @PostMapping("/events")
  public Mono<ResponseEntity<Void>> record(@RequestBody AuditEventDto event) {
    return auditService.record(event)
        .thenReturn(ResponseEntity.noContent().build());
  }

  /**
   * Query audit events with optional filters.
   *
   * <p>Requires a userId filter for data isolation (enforced by gateway).
   */
  @GetMapping("/events")
  public Mono<ResponseEntity<List<AuditEventDto>>> query(
      @RequestParam(required = false) UUID userId,
      @RequestParam(required = false) String kind,
      @RequestParam(required = false) String severity,
      @RequestParam(required = false, defaultValue = "50") Integer limit,
      @RequestParam(required = false, defaultValue = "0") Integer offset) {

    var request = new AuditQueryRequest(userId, kind, severity, limit, offset);
    return auditService.query(request)
        .map(events -> ResponseEntity.ok(events));
  }
}