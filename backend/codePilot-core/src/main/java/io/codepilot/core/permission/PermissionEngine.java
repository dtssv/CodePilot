package io.codepilot.core.permission;

import io.codepilot.core.agent.AgentDefinition;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Evaluates whether a tool/action is allowed, denied, or requires user approval.
 *
 * <p>Merges three layers of rules (in priority order):
 * <ol>
 *   <li>Agent-specific rules (from AgentDefinition.permissionRules)</li>
 *   <li>User-configured rules (from DB/config)</li>
 *   <li>Default rules (sensible baseline)</li>
 * </ol>
 *
 * <p>Permission.merge(defaults, agentSpecific, userOverrides).
 *
 * <p>Permission rules use short category names (e.g. "read", "write", "bash") while tools
 * have qualified names (e.g. "fs.read", "fs.write", "shell.exec"). The {@link #toCategory}
 * method maps tool names to their permission categories before evaluation.
 */
@Service
public class PermissionEngine {

  private static final Logger log = LoggerFactory.getLogger(PermissionEngine.class);

  /** Map qualified tool names to short permission category names. */
  private static final Map<String, String> TOOL_CATEGORY_MAP = Map.ofEntries(
      // ── File read tools (read-only) ──
      Map.entry("fs.read", "read"),
      Map.entry("fs.list", "list"),
      Map.entry("fs.search", "grep"),
      Map.entry("fs.grep", "grep"),
      Map.entry("fs.outline", "read"),
      // ── File write tools (mutating) ──
      Map.entry("fs.write", "write"),
      Map.entry("fs.create", "write"),
      Map.entry("fs.replace", "edit"),
      Map.entry("fs.delete", "write"),
      Map.entry("fs.move", "write"),
      Map.entry("fs.applyPatch", "edit"),
      // ── Shell tools ──
      Map.entry("shell.exec", "bash"),
      Map.entry("shell.session", "bash"),
      // ── Code intelligence tools (read-only) ──
      Map.entry("code.outline", "read"),
      Map.entry("code.symbol", "read"),
      Map.entry("code.usages", "read"),
      // ── IDE tools ──
      Map.entry("ide.openFile", "read"),
      Map.entry("ide.diagnostics", "read"),
      Map.entry("ide.applyPatch", "edit"),
      Map.entry("ide.shadowValidate", "edit"),
      // ── Notepad tools ──
      Map.entry("notepad.write", "write"),
      Map.entry("notepad.read", "read"),
      // ── VCS tools ──
      Map.entry("commit", "commit"),
      // ── Interactive tools ──
      Map.entry("ask_user", "question"),
      // ── Local tools ──
      Map.entry("memory", "memory"),
      Map.entry("skill", "skill"),
      Map.entry("task_create", "task_create"),
      Map.entry("task_update", "task_update"),
      Map.entry("task_list", "task_list"),
      // ── Special categories ──
      Map.entry("plan", "plan"),
      Map.entry("doom_loop", "doom_loop"));

  /**
   * Resolve a qualified tool name to its short permission category.
   * Returns the tool name itself if no mapping exists (e.g. MCP tools).
   */
  public static String toCategory(String toolName) {
    if (toolName == null) return null;
    // Check direct mapping first
    String category = TOOL_CATEGORY_MAP.get(toolName);
    if (category != null) return category;
    // MCP tools: mcp.<server>.<tool> → "mcp"
    if (toolName.startsWith("mcp.")) return "mcp";
    // Fallback: return the tool name as-is
    return toolName;
  }

  /** Default baseline rules — all tools allowed, with specific restrictions. */
  private static final PermissionRuleset DEFAULT_RULES = PermissionRuleset.builder()
      .allow("*")                          // All tools allowed by default
      .ask("doom_loop")                    // Ask when doom loop detected
      .ask("external_directory", "*")      // Ask for paths outside workspace
      .ask("read", "*.env")                // Ask before reading .env files
      .ask("read", "*.env.*")              // Ask before reading .env.* files
      .allow("read", "*.env.example")      // But .env.example is fine
      .deny("question")                    // Don't ask user questions by default
      .deny("plan_enter")                  // Don't enter plan mode by default
      .deny("plan_exit")                   // Don't exit plan mode by default
      .build();

  private volatile PermissionRuleset userOverrides = new PermissionRuleset();

  /**
   * Evaluate whether a tool invocation is permitted.
   *
   * @param agent     The agent definition requesting the tool
   * @param toolName  The name of the tool being invoked
   * @param target    Optional target/resource identifier (e.g., file path)
   * @return The action: ALLOW, DENY, or ASK
   */
  public PermissionRule.Action evaluate(AgentDefinition agent, String toolName, String target) {
    return evaluate(agent, null, toolName, target);
  }

  /**
   * Evaluate with a per-session override ruleset. Precedence (first match wins):
   * agent rules → session override → global user overrides → defaults → ALLOW.
   *
   * <p>The session override is passed per-request (not stored on this singleton), so
   * concurrent sessions with different overrides do not interfere.
   */
  public PermissionRule.Action evaluate(
      AgentDefinition agent, PermissionRuleset sessionOverride, String toolName, String target) {
    if (target == null) target = "*";
    String category = toCategory(toolName);

    // Layer 1: Agent-specific rules (highest priority)
    if (agent != null && agent.permissionRules() != null) {
      PermissionRule.Action agentAction = agent.permissionRules().evaluate(category, target);
      if (agentAction != null) return agentAction;
    }

    // Layer 2: Per-session overrides supplied by the user for this run
    if (sessionOverride != null) {
      PermissionRule.Action sessionAction = sessionOverride.evaluate(category, target);
      if (sessionAction != null) return sessionAction;
    }

    // Layer 3: Global user-configured overrides
    PermissionRule.Action userAction = userOverrides.evaluate(category, target);
    if (userAction != null) return userAction;

    // Layer 4: Default rules
    PermissionRule.Action defaultAction = DEFAULT_RULES.evaluate(category, target);
    if (defaultAction != null) return defaultAction;

    // Fallback: allow
    return PermissionRule.Action.ALLOW;
  }

  /**
   * Check if a specific tool is in the agent's tool allowlist.
   * If the agent has no toolAllowlist (null or empty), all tools are allowed.
   */
  public boolean isToolAllowed(AgentDefinition agent, String toolName) {
    if (agent == null) return true;
    var allowlist = agent.toolAllowlist();
    if (allowlist == null || allowlist.isEmpty()) return true;
    return allowlist.contains(toolName);
  }

  /**
   * Update user permission overrides from config.
   */
  public void setUserOverrides(Map<String, Object> config) {
    this.userOverrides = PermissionRuleset.fromConfig(config);
    log.info("Updated user permission overrides with {} top-level entries",
        config != null ? config.size() : 0);
  }

  public PermissionRuleset getDefaultRules() { return DEFAULT_RULES; }
  public PermissionRuleset getUserOverrides() { return userOverrides; }
}
