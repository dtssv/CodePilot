package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.move — move or rename a file. */
@Component
public class FileMoveTool {
  public static final String NAME = "fs.move";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Move or rename a file from one path to another.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "source", Map.of("type", "string", "description", "Current absolute path of the file."),
                "destination", Map.of("type", "string", "description", "Target absolute path for the file.")),
            "required", List.of("source", "destination")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
