package io.codepilot.core.permission;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * An ordered list of permission rules. Evaluation is first-match-wins.
 * Rules are applied in the order they appear in the list.
 *
 * <p>Permission.Ruleset which is an ordered array of
 * {permission, action, pattern} tuples.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PermissionRuleset {

  private final List<PermissionRule> rules;

  public PermissionRuleset() {
    this.rules = new ArrayList<>();
  }

  public PermissionRuleset(List<PermissionRule> rules) {
    this.rules = rules != null ? new ArrayList<>(rules) : new ArrayList<>();
  }

  public List<PermissionRule> rules() {
    return Collections.unmodifiableList(rules);
  }

  /**
   * Evaluate the ruleset for a given permission and target.
   * Returns the action of the first matching rule, or null if no rule matches.
   */
  public PermissionRule.Action evaluate(String permission, String target) {
    for (PermissionRule rule : rules) {
      if (rule.matches(permission, target)) {
        return rule.action();
      }
    }
    return null;
  }

  /**
   * Evaluate and return a default action if no rule matches.
   */
  public PermissionRule.Action evaluate(String permission, String target, PermissionRule.Action defaultAction) {
    PermissionRule.Action result = evaluate(permission, target);
    return result != null ? result : defaultAction;
  }

  /**
   * Merge another ruleset after this one. The other ruleset's rules are appended,
   * giving them lower priority (evaluated only if no rule in this set matches).
   */
  public PermissionRuleset merge(PermissionRuleset other) {
    if (other == null) return this;
    List<PermissionRule> merged = new ArrayList<>(this.rules);
    merged.addAll(other.rules);
    return new PermissionRuleset(merged);
  }

  /**
   * Build a ruleset from a config-style map.
   * Map format: { "permission_name": "action" } or { "permission_name": { "pattern": "action" } }
   * Example: { "read": "allow", "edit": { "*.env": "ask", "*": "deny" }, "bash": "ask" }
   */
  @SuppressWarnings("unchecked")
  public static PermissionRuleset fromConfig(Map<String, Object> config) {
    if (config == null) return new PermissionRuleset();
    List<PermissionRule> rules = new ArrayList<>();
    for (var entry : config.entrySet()) {
      String permission = entry.getKey();
      Object value = entry.getValue();
      if (value instanceof String actionStr) {
        PermissionRule.Action action = parseAction(actionStr);
        rules.add(new PermissionRule(permission, action, "*"));
      } else if (value instanceof Map<?, ?> patternMap) {
        for (var patternEntry : patternMap.entrySet()) {
          String pattern = patternEntry.getKey().toString();
          PermissionRule.Action action = parseAction(patternEntry.getValue().toString());
          rules.add(new PermissionRule(permission, action, pattern));
        }
      }
    }
    return new PermissionRuleset(rules);
  }

  private static PermissionRule.Action parseAction(String action) {
    return switch (action.toLowerCase().trim()) {
      case "allow" -> PermissionRule.Action.ALLOW;
      case "deny" -> PermissionRule.Action.DENY;
      case "ask" -> PermissionRule.Action.ASK;
      default -> PermissionRule.Action.ALLOW;
    };
  }

  /** Builder for constructing rulesets fluently. */
  public static Builder builder() { return new Builder(); }

  public static class Builder {
    private final List<PermissionRule> rules = new ArrayList<>();

    public Builder rule(String permission, PermissionRule.Action action, String pattern) {
      rules.add(new PermissionRule(permission, action, pattern));
      return this;
    }
    public Builder allow(String permission) { return rule(permission, PermissionRule.Action.ALLOW, "*"); }
    public Builder allow(String permission, String pattern) { return rule(permission, PermissionRule.Action.ALLOW, pattern); }
    public Builder deny(String permission) { return rule(permission, PermissionRule.Action.DENY, "*"); }
    public Builder deny(String permission, String pattern) { return rule(permission, PermissionRule.Action.DENY, pattern); }
    public Builder ask(String permission) { return rule(permission, PermissionRule.Action.ASK, "*"); }
    public Builder ask(String permission, String pattern) { return rule(permission, PermissionRule.Action.ASK, pattern); }

    public PermissionRuleset build() { return new PermissionRuleset(rules); }
  }
}
