package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.create — create a new file with content. */
@Component
public class FileCreateTool {
  public static final String NAME = "fs.create";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Create a new file at the specified path with the given content. "
            + "Fails if the file already exists unless overwrite is set to true.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "Absolute path for the new file."),
                "content", Map.of("type", "string", "description", "The content to write to the file."),
                "overwrite", Map.of("type", "boolean", "description", "Whether to overwrite if file exists (default false).")),
            "required", List.of("path", "content")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
