package io.codepilot.core.task;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.tool.ToolDefinition;
import io.codepilot.core.session.tool.ToolExecutor;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class TaskCreateTool {

  private final TaskService taskService;

  public TaskCreateTool(TaskService taskService) {
    this.taskService = taskService;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        "task_create",
        "Create a new task to track progress. Tasks form a tree with checkpoint integration.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "title", Map.of("type", "string", "description", "Task title"),
                    "description", Map.of("type", "string", "description", "Optional description"),
                    "parentId",
                        Map.of("type", "string", "description", "Parent task ID (e.g., 'T1')")),
            "required", List.of("title")),
        false,
        false);
  }

  public ToolExecutor executor() {
    return call -> {
      @SuppressWarnings("unchecked")
      Map<String, Object> args = call.args();
      String title = (String) args.get("title");
      if (title == null || title.isBlank()) return new ToolResult(false, "Missing 'title'");

      TaskInfo task =
          taskService.create(
              call.sessionId(),
              (String) args.get("parentId"),
              title,
              (String) args.getOrDefault("description", ""));
      return new ToolResult(true, "Task created: " + task.id() + " - " + task.title());
    };
  }
}
