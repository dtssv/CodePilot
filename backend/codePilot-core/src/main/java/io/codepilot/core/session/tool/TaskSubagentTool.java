package io.codepilot.core.session.tool;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.subagent.SubagentService;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Tool: task_subagent — spawn a subagent to handle a specific subtask. */
@Component
public class TaskSubagentTool {
  public static final String NAME = "task_subagent";

  private final SubagentService subagentService;

  public TaskSubagentTool(SubagentService subagentService) {
    this.subagentService = subagentService;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Spawn a subagent to handle a specific subtask independently. "
            + "Returns a task ID you can use later to check the result.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "description",
                    Map.of(
                        "type",
                        "string",
                        "description",
                        "Description of the subtask for the subagent.")),
            "required", List.of("description")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> {
      String description = (String) call.args().get("description");
      if (description == null || description.isBlank()) {
        return new ToolResult(false, "Missing required parameter: description");
      }
      try {
        String taskId = subagentService.runAsync("subagent_" + call.sessionId(), description);
        return new ToolResult(
            true,
            "Subagent task spawned with ID: "
                + taskId
                + ". "
                + "After some time, the subagent's result will be appended to the conversation.");
      } catch (Exception e) {
        return new ToolResult(false, "Failed to spawn subagent: " + e.getMessage());
      }
    };
  }
}
