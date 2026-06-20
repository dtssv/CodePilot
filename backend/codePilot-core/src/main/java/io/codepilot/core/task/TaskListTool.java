package io.codepilot.core.task;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.tool.ToolDefinition;
import io.codepilot.core.session.tool.ToolExecutor;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class TaskListTool {

  private final TaskService taskService;

  public TaskListTool(TaskService taskService) {
    this.taskService = taskService;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        "task_list",
        "List all tasks and their progress for the current session.",
        Map.of("type", "object", "properties", Map.of()),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new ToolResult(true, taskService.formatForPrompt(call.sessionId()));
  }
}
