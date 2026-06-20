package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: ide.diagnostics — get IDE diagnostics (errors, warnings) for files. */
@Component
public class IdeDiagnosticsTool {
  public static final String NAME = "ide.diagnostics";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Get IDE diagnostics (errors, warnings, info) for specified files or the entire project. "
            + "Returns compiler errors, linter warnings, and other analysis results.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "paths", Map.of(
                    "type", "array",
                    "items", Map.of("type", "string"),
                    "description", "List of file paths to check. If empty, checks all open files."),
                "severities", Map.of(
                    "type", "array",
                    "items", Map.of("type", "string"),
                    "description", "Filter by severity: 'error', 'warning', 'info'.")),
            "required", List.of()),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
