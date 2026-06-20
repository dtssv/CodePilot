package io.codepilot.core.permission;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A single permission rule: when a tool/action matching {permission} is invoked
 * on a target matching {pattern}, the {action} is applied.
 *
 * <p> Permission system where rules are evaluated in order
 * and the first match wins. Actions: allow, deny, ask (prompt user).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PermissionRule(
    @JsonProperty("permission") String permission,
    @JsonProperty("action") Action action,
    @JsonProperty("pattern") String pattern) {

  public enum Action {
    @JsonProperty("allow") ALLOW,
    @JsonProperty("deny") DENY,
    @JsonProperty("ask") ASK
  }

  /**
   * Check if this rule matches the given permission and target.
   * Permission matching: exact match or wildcard "*".
   * Pattern matching: exact match, wildcard "*", or glob-style (e.g., "*.env", "path/**").
   */
  public boolean matches(String permission, String target) {
    boolean permMatch = "*".equals(this.permission) || this.permission.equals(permission);
    if (!permMatch) return false;
    if (target == null || pattern == null || "*".equals(this.pattern)) return true;
    return globMatch(this.pattern, target);
  }

  /** Simple glob matching: supports * (any segment) and ** (any path). */
  static boolean globMatch(String pattern, String target) {
    // Exact match
    if (pattern.equals(target)) return true;
    // Convert glob to regex
    String regex = pattern
        .replace(".", "\\.")
        .replace("**/", "(.*/)?")
        .replace("**", ".*")
        .replace("*", "[^/]*")
        .replace("?", ".");
    return target.matches(regex);
  }

  // Factory methods
  public static PermissionRule allow(String permission, String pattern) {
    return new PermissionRule(permission, Action.ALLOW, pattern);
  }
  public static PermissionRule deny(String permission, String pattern) {
    return new PermissionRule(permission, Action.DENY, pattern);
  }
  public static PermissionRule ask(String permission, String pattern) {
    return new PermissionRule(permission, Action.ASK, pattern);
  }
}
