package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: ide.shadowValidate — validate changes in a shadow/scratch workspace. */
@Component
public class IdeShadowValidateTool {
  public static final String NAME = "ide.shadowValidate";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Validate proposed changes in a shadow (scratch) workspace before applying. "
            + "Runs build/lint checks on the shadow copy to verify changes are safe.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "paths", Map.of(
                    "type", "array",
                    "items", Map.of("type", "string"),
                    "description", "Files to validate in the shadow workspace."),
                "command", Map.of("type", "string", "description", "Validation command to run (e.g. build, lint).")),
            "required", List.of("paths")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
