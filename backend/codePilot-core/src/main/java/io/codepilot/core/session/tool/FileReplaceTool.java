package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.replace — search-and-replace within a file. */
@Component
public class FileReplaceTool {
  public static final String NAME = "fs.replace";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Search for a text pattern in a file and replace it with new content. "
            + "Use this for targeted edits to existing files.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "Absolute path to the file to edit."),
                "search", Map.of("type", "string", "description", "The exact text to search for."),
                "replace", Map.of("type", "string", "description", "The replacement text."),
                "regex", Map.of("type", "boolean", "description", "Whether search is a regex pattern (default false).")),
            "required", List.of("path", "search", "replace")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
