package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.applyPatch — apply one or more patches to files. */
@Component
public class FileApplyPatchTool {
  public static final String NAME = "fs.applyPatch";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Apply one or more search-replace patches to files. Supports single-edit and batch modes. "
            + "Each patch specifies a path, operation (create/replace/delete), and content.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "patches", Map.of(
                    "type", "array",
                    "description", "Array of patch operations to apply.",
                    "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                            "path", Map.of("type", "string", "description", "File path."),
                            "op", Map.of("type", "string", "description", "Operation: create, replace, or delete."),
                            "search", Map.of("type", "string", "description", "Text to search for (for replace op)."),
                            "replace", Map.of("type", "string", "description", "Replacement text."),
                            "newContent", Map.of("type", "string", "description", "Full new content (for create/replace op)."))))),
            "required", List.of("patches")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
