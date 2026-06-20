package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: code.usages — find all references/usages of a symbol. */
@Component
public class CodeUsagesTool {
  public static final String NAME = "code.usages";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Find all references and usages of a symbol across the project. "
            + "Returns file paths and line numbers where the symbol is used.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "symbol", Map.of("type", "string", "description", "Symbol name to find usages for."),
                "path", Map.of("type", "string", "description", "File containing the symbol definition (for disambiguation)."),
                "line", Map.of("type", "integer", "description", "Line number of the symbol definition.")),
            "required", List.of("symbol")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
