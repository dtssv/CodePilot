package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: ide.applyPatch — apply a patch via the IDE's built-in diff/merge. */
@Component
public class IdeApplyPatchTool {
  public static final String NAME = "ide.applyPatch";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Apply a patch to a file using the IDE's built-in diff viewer. "
            + "Shows the change in a diff view for user review before applying.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "path", Map.of("type", "string", "description", "File path to patch."),
                "search", Map.of("type", "string", "description", "Text to search for."),
                "replace", Map.of("type", "string", "description", "Replacement text."),
                "newContent", Map.of("type", "string", "description", "Full new file content (alternative to search/replace).")),
            "required", List.of("path")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
