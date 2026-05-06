package io.codepilot.core.audit;

import io.codepilot.common.api.TraceIdHolder;
import io.codepilot.core.audit.AuditRepository;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Centralized audit event publisher. Called from ConversationService, AuthController,
 * SystemPromptLeakDetector, and ToolDispatcher at their critical paths.
 *
 * <p>This is NOT an AOP aspect to keep things explicit and debuggable; callers invoke
 * methods directly.
 */
@Component
public class AuditInterceptor {

  private static final Logger log = LoggerFactory.getLogger(AuditInterceptor.class);

  private final AuditRepository auditRepo;

  public AuditInterceptor(AuditRepository auditRepo) {
    this.auditRepo = auditRepo;
  }

  /** Audit: conversation started. */
  public void conversationStarted(String userId, String deviceId, String sessionId, String mode) {
    insert("conversation_started", userId, deviceId, Map.of("sessionId", sessionId, "mode", mode));
  }

  /** Audit: conversation completed. */
  public void conversationCompleted(String userId, String deviceId, String sessionId, String reason, int turns) {
    insert("conversation_completed", userId, deviceId,
        Map.of("sessionId", sessionId, "reason", reason, "turns", turns));
  }

  /** Audit: tool executed. */
  public void toolExecuted(String userId, String deviceId, String toolName, String toolCallId, boolean ok, long durationMs) {
    insert("tool_executed", userId, deviceId,
        Map.of("tool", toolName, "toolCallId", toolCallId, "ok", ok, "durationMs", durationMs));
  }

  /** Audit: auth login attempt. */
  public void authLogin(String userId, String deviceId, boolean success, String method) {
    insert(success ? "auth_login_success" : "auth_login_failed", userId, deviceId,
        Map.of("method", method));
  }

  /** Audit: system prompt leak detected (pre-filter). */
  public void leakDetectedPre(String userId, String matchedRule) {
    insert("system_prompt_leak_pre", userId, null,
        Map.of("matchedRule", matchedRule));
  }

  /** Audit: system prompt leak detected (post-filter). */
  public void leakDetectedPost(String userId, String matchedRule) {
    insert("system_prompt_leak_post", userId, null,
        Map.of("matchedRule", matchedRule));
  }

  /** Audit: security-blocked request. */
  public void securityBlocked(String userId, String deviceId, String reason) {
    auditRepo.insert(
        TraceIdHolder.current(), null, userId, deviceId,
        "security_blocked", "warn", null, reason, null, null, Map.of());
  }

  /** Audit: command blocked by shell executor. */
  public void commandBlocked(String userId, String deviceId, String command) {
    insert("command_blocked", userId, deviceId, Map.of("command", truncate(command, 100)));
  }

  // ---- Private ---- //

  private void insert(String kind, String userId, String deviceId, Map<String, Object> extra) {
    try {
      auditRepo.insert(
          TraceIdHolder.current(),
          null, // tenantId — resolved downstream if needed
          userId,
          deviceId,
          kind,
          "info",
          null,
          null,
          null,
          null,
          extra);
    } catch (Exception e) {
      log.warn("Audit insert failed for kind={}: {}", kind, e.getMessage());
    }
  }

  private static String truncate(String s, int max) {
    return s == null ? "" : (s.length() <= max ? s : s.substring(0, max));
  }
}