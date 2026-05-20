package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** LLM-inferred intake routing: whether/how to use tools before the main agent loop. */
public record IntakeIntent(
    boolean needsTools, boolean needsPlanning, List<ToolHint> tools, String reason) {

  private static final Set<String> GATHER_TOOL_PREFIXES =
      Set.of("fs.read", "fs.list", "fs.grep", "fs.search", "fs.outline", "code.", "rag.search", "ide.");

  public record ToolHint(String name, String why) {}

  /** Full agent pipeline when classification fails. */
  public static IntakeIntent defaults() {
    return new IntakeIntent(false, true, List.of(), "");
  }

  /** Direct text answer — no tools, no multi-step plan. */
  public boolean conversationalOnly() {
    return !needsTools && !needsPlanning;
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
    if (reason != null && !reason.isBlank()) {
      m.put("reason", reason);
    }
    return m;
  }
}
