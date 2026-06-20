package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.outline — get a brief outline/summary of a file. */
@Component
public class FileOutlineTool {
  public static final String NAME = "fs.outline";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Get a brief outline of a file — line count, first non-empty line, and basic structure.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "Absolute path to the file.")),
            "required", List.of("path")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
