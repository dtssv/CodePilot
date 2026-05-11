package io.codepilot.core.audit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Audit repository for persisting audit events to PostgreSQL.
 * All audit events are stored in audit_events table with traceId for cross-service correlation.
 * Never stores raw user code content - only paths, tool names, and metadata.
 * All writes are async to avoid blocking the request path.
 */
@Repository
public class AuditRepository {

    private static final Logger log = LoggerFactory.getLogger(AuditRepository.class);
    private final JdbcTemplate jdbc;

    public AuditRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Async
    public void saveEvent(String traceId, String sessionId, String action,
                          String actor, String payload, boolean privacyMode) {
        try {
            String id = UUID.randomUUID().toString();
            String timestamp = Instant.now().toString();
            String safePayload = privacyMode ? "{\"privacyMode\":\"strict\"}" : payload;
            String safeActor = privacyMode ? "anonymous" : actor;
            jdbc.update(
                "INSERT INTO audit_events (id, trace_id, session_id, action, actor, payload, privacy_mode, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?::timestamptz)",
                id, traceId, sessionId, action, safeActor, safePayload, privacyMode, timestamp
            );
        } catch (Exception e) {
            log.error("Failed to persist audit event: action={}, traceId={}", action, traceId, e);
        }
    }

    @Async
    public void saveToolExecution(String traceId, String sessionId, String toolCallId,
                                  String toolName, boolean ok, long durationMs,
                                  String actor, boolean privacyMode) {
        String payload = String.format(
            "{\"toolCallId\":\"%s\",\"toolName\":\"%s\",\"ok\":%b,\"durationMs\":%d}",
            toolCallId, toolName, ok, durationMs
        );
        saveEvent(traceId, sessionId, "tool.execute", actor, payload, privacyMode);
    }

    @Async
    public void saveSkillActivation(String traceId, String sessionId,
                                    String skillId, String skillVersion,
                                    String source, String actor, boolean privacyMode) {
        String payload = String.format(
            "{\"skillId\":\"%s\",\"version\":\"%s\",\"source\":\"%s\"}",
            skillId, skillVersion, source
        );
        saveEvent(traceId, sessionId, "skill.activated", actor, payload, privacyMode);
    }

    @Async
    public void saveSecurityEvent(String traceId, String sessionId,
                                  String eventType, String detail,
                                  String actor, boolean privacyMode) {
        String safeDetail = detail != null ? detail.substring(0, Math.min(detail.length(), 200)) : "";
        String payload = String.format(
            "{\"eventType\":\"%s\",\"detail\":\"%s\"}", eventType, safeDetail
        );
        saveEvent(traceId, sessionId, "security." + eventType, actor, payload, privacyMode);
    }

    public void insert(String traceId, String tenantId, String userId, String deviceId,
                       String action, String level, String sessionId,
                       String detail, String toolCallId, String toolName,
                       Map<String, ? extends Object> extra) {
        try {
            String id = UUID.randomUUID().toString();
            String timestamp = Instant.now().toString();
            String payload = String.format(
                "{\"action\":\"%s\",\"level\":\"%s\",\"detail\":\"%s\",\"toolCallId\":\"%s\",\"toolName\":\"%s\",\"extra\":%s}",
                escapeJson(action), escapeJson(level),
                detail != null ? escapeJson(detail) : "",
                toolCallId != null ? escapeJson(toolCallId) : "",
                toolName != null ? escapeJson(toolName) : "",
                extra != null ? mapToJson(extra) : "{}"
            );
            String actor = userId != null ? userId : "system";
            jdbc.update(
                "INSERT INTO audit_events (id, trace_id, session_id, action, actor, payload, privacy_mode, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?::timestamptz)",
                id, traceId, sessionId, action, actor, payload, false, timestamp
            );
        } catch (Exception e) {
            log.error("Failed to insert audit event: action={}, traceId={}", action, traceId, e);
        }
    }

    public void ensureTable() {
        try {
            jdbc.execute("""
                CREATE TABLE IF NOT EXISTS audit_events (
                    id VARCHAR(36) PRIMARY KEY,
                    trace_id VARCHAR(64),
                    session_id VARCHAR(64),
                    action VARCHAR(128) NOT NULL,
                    actor VARCHAR(128),
                    payload JSONB,
                    privacy_mode BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL
                )
                """);
            jdbc.execute("CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events (trace_id)");
            jdbc.execute("CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events (session_id)");
            jdbc.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events (action)");
            jdbc.execute("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events (created_at)");
            log.info("Audit events table initialized");
        } catch (Exception e) {
            log.warn("Failed to initialize audit table (will continue without persistence)", e);
        }
    }

    private static String escapeJson(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private static String mapToJson(Map<String, ? extends Object> map) {
        if (map == null || map.isEmpty()) return "{}";
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, ? extends Object> entry : map.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\"").append(escapeJson(entry.getKey())).append("\":");
            Object v = entry.getValue();
            if (v instanceof String) {
                sb.append("\"").append(escapeJson(v.toString())).append("\"");
            } else if (v instanceof Boolean || v instanceof Number) {
                sb.append(v);
            } else {
                sb.append("\"").append(escapeJson(v != null ? v.toString() : "")).append("\"");
            }
        }
        sb.append("}");
        return sb.toString();
    }
}