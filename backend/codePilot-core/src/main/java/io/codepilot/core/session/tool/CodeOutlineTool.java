package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: code.outline — get code structure outline of a source file. */
@Component
public class CodeOutlineTool {
  public static final String NAME = "code.outline";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Get the code structure outline of a source file — classes, methods, functions, "
            + "and their signatures. Returns a structured overview of the file's AST.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "Absolute path to the source file.")),
            "required", List.of("path")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
