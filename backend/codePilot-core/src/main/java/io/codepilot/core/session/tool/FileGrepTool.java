package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.grep — search file contents with regex pattern. */
@Component
public class FileGrepTool {
  public static final String NAME = "fs.grep";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Search file contents using a text pattern or regular expression. "
            + "Returns matching lines with file path and line number.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "pattern", Map.of("type", "string", "description", "Search pattern (literal or regex)."),
                "path", Map.of("type", "string", "description", "Directory or file to search in (default: project root)."),
                "regex", Map.of("type", "boolean", "description", "Whether the pattern is a regex (default false)."),
                "include", Map.of("type", "string", "description", "Glob pattern for files to include (e.g. '*.java')."),
                "maxResults", Map.of("type", "integer", "description", "Maximum number of results (default 50).")),
            "required", List.of("pattern")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
