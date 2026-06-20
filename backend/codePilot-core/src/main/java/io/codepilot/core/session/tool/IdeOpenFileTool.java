package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: ide.openFile — open a file in the IDE editor. */
@Component
public class IdeOpenFileTool {
  public static final String NAME = "ide.openFile";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Open a file in the IDE editor, optionally at a specific line.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "Absolute path of the file to open."),
                "line", Map.of("type", "integer", "description", "Line number to scroll to.")),
            "required", List.of("path")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
