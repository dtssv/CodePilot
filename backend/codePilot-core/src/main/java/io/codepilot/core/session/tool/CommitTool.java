package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: commit — create a git commit with staged changes. */
@Component
public class CommitTool {
  public static final String NAME = "commit";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Create a git commit with the given message. Stages all changed files unless "
            + "specific paths are provided.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "message", Map.of("type", "string", "description", "Commit message."),
                "paths", Map.of(
                    "type", "array",
                    "items", Map.of("type", "string"),
                    "description", "Specific file paths to stage and commit. If empty, stages all changes."),
                "addAll", Map.of("type", "boolean", "description", "Whether to stage all changes (default true).")),
            "required", List.of("message")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
