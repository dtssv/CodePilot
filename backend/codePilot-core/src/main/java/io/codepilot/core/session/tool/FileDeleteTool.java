package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.delete — delete a file. */
@Component
public class FileDeleteTool {
  public static final String NAME = "fs.delete";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Delete a file at the specified path.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "Absolute path of the file to delete.")),
            "required", List.of("path")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
