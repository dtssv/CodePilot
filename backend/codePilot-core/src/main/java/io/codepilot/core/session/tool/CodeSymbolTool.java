package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: code.symbol — find symbol definitions by name. */
@Component
public class CodeSymbolTool {
  public static final String NAME = "code.symbol";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Find symbol definitions (classes, functions, variables) by name. "
            + "Returns file path, line number, and signature.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "query", Map.of("type", "string", "description", "Symbol name or pattern to search for."),
                "kind", Map.of("type", "string", "description", "Symbol kind filter: class, function, variable, etc.")),
            "required", List.of("query")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
