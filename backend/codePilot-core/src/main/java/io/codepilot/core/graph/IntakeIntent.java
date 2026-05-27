package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * LLM-inferred intake routing: determines the execution strategy for a task.
 *
 * <p>Design principle: dispatchPath is determined by <b>task complexity</b>,
 * not by tool type. MCP tools and Skills are <b>execution resources</b>
 * available during task execution — not routing destinations. The LLM decides
 * when to use them within the GRAPH pipeline (via generate→gather→mcp.call)
 * or the SIMPLE pipeline (via intentDispatch with tool injection).
 *
 * <p>Three dispatch paths:
 * <ul>
 *   <li>{@link DispatchPath#CONVERSATIONAL} — pure Q&A, no tools, no planning</li>
 *   <li>{@link DispatchPath#SIMPLE} — needs tools but no multi-step plan</li>
 *   <li>{@link DispatchPath#GRAPH} — needs multi-step planning and execution</li>
 * </ul>
 */
public record IntakeIntent(
    boolean needsTools, boolean needsPlanning, List<ToolHint> tools, String reason,
    /** How the graph should route after intake — determined by task complexity. */
    DispatchPath dispatchPath) {

  /**
   * Routing path after intake — determined by task complexity, NOT by tool type.
   *
   * <p>MCP tools and Skills are available as resources in both SIMPLE and GRAPH paths.
   * The difference is whether the task needs multi-step planning:
   * <ul>
   *   <li>CONVERSATIONAL: no tools, no planning → direct LLM answer</li>
   *   <li>SIMPLE: needs tools, no planning → LLM + tool execution in one round</li>
   *   <li>GRAPH: needs planning → full pipeline with phases</li>
   * </ul>
   */
  public enum DispatchPath {
    /** Full graph pipeline: planning → generate → applyPatch → verify → commit → finalize. */
    GRAPH,
    /** Direct conversational answer — no tools, no planning. Go straight to finalize. */
    CONVERSATIONAL,
    /** Single-round tool-assisted execution — needs tools but no multi-step plan.
     *  MCP tools and Skills are injected as resources, not as routing targets. */
    SIMPLE
  }

  private static final Set<String> GATHER_TOOL_PREFIXES =
      Set.of("fs.read", "fs.list", "fs.grep", "fs.search", "fs.outline", "code.", "rag.search", "ide.");

  public record ToolHint(String name, String why) {}

  /** Full agent pipeline when classification fails. */
  public static IntakeIntent defaults() {
    return new IntakeIntent(false, true, List.of(), "", DispatchPath.GRAPH);
  }

  /** Direct text answer — no tools, no multi-step plan. */
  public boolean conversationalOnly() {
    return dispatchPath == DispatchPath.CONVERSATIONAL
        || (!needsTools && !needsPlanning);
  }

  /** Single-round tool-assisted execution — needs tools but no multi-step plan. */
  public boolean isSimple() {
    return dispatchPath == DispatchPath.SIMPLE;
  }

  /**
   * @deprecated Use {@link #isSimple()} instead. MCP is a resource, not a routing path.
   */
  @Deprecated(since = "0.9", forRemoval = true)
  public boolean isMcpDirect() {
    return false;
  }

  /**
   * @deprecated Use {@link #isSimple()} instead. Skill is a resource, not a routing path.
   */
  @Deprecated(since = "0.9", forRemoval = true)
  public boolean isSkillDirect() {
    return false;
  }

  /** Read/search/diagnostic tools suggested — generate should gather real context. */
  public boolean requireFileGather() {
    if (!needsTools || tools == null || tools.isEmpty()) {
      return false;
    }
    return tools.stream().anyMatch(t -> isGatherLikeTool(t.name()));
  }

  /** shell.exec suggested — allow mutating commands in gather/direct paths. */
  public boolean allowShellExec() {
    if (!needsTools || tools == null) {
      return false;
    }
    return tools.stream().anyMatch(t -> "shell.exec".equals(t.name()));
  }

  private static boolean isGatherLikeTool(String name) {
    if (name == null || name.isBlank()) {
      return false;
    }
    if ("shell.exec".equals(name)) {
      return false;
    }
    if (name.startsWith("fs.applyPatch") || "fs.create".equals(name) || "fs.write".equals(name)) {
      return false;
    }
    for (String prefix : GATHER_TOOL_PREFIXES) {
      if (name.equals(prefix) || name.startsWith(prefix)) {
        return true;
      }
    }
    return name.startsWith("mcp.");
  }

  public List<Map<String, Object>> toolsAsMaps() {
    List<Map<String, Object>> out = new ArrayList<>();
    if (tools == null) {
      return out;
    }
    for (ToolHint t : tools) {
      if (t.name() == null || t.name().isBlank()) {
        continue;
      }
      out.add(Map.of("name", t.name(), "why", t.why() != null ? t.why() : ""));
    }
    return out;
  }

  public Map<String, Object> toMap() {
    var m = new LinkedHashMap<String, Object>();
    m.put("needsTools", needsTools);
    m.put("needsPlanning", needsPlanning);
    m.put("tools", toolsAsMaps());
    m.put("dispatchPath", dispatchPath.name());
    if (reason != null && !reason.isBlank()) {
      m.put("reason", reason);
    }
    return m;
  }
}
