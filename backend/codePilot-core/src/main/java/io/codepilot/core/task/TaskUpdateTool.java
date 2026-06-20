package io.codepilot.core.task;

import io.codepilot.core.agent.tool.ToolResult;
import io.codepilot.core.session.tool.ToolDefinition;
import io.codepilot.core.session.tool.ToolExecutor;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class TaskUpdateTool {

  private final TaskService taskService;

  public TaskUpdateTool(TaskService taskService) {
    this.taskService = taskService;
  }

  public ToolDefinition definition() {
    return new ToolDefinition(
        "task_update",
        "Update a task's status. Statuses: pending, in_progress, completed, failed.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "id", Map.of("type", "string", "description", "Task ID (e.g., 'T1')"),
                    "status",
                        Map.of(
                            "type",
                            "string",
                            "enum",
                            List.of("pending", "in_progress", "completed", "failed"),
                            "description",
                            "New status")),
            "required", List.of("id", "status")),
        false,
        false);
  }

  public ToolExecutor executor() {
    return call -> {
      @SuppressWarnings("unchecked")
      Map<String, Object> args = call.args();
      String id = (String) args.get("id");
      String statusStr = (String) args.get("status");
      if (id == null || statusStr == null) return new ToolResult(false, "Missing 'id' or 'status'");
      try {
        TaskInfo.Status status = TaskInfo.Status.valueOf(statusStr.toUpperCase());
        var updated = taskService.update(call.sessionId(), id, status);
        if (updated.isEmpty()) {
          return new ToolResult(false, "Task not found: " + id + ". Use task_create first.");
        }
        return new ToolResult(true, "Task " + id + " updated to " + statusStr);
      } catch (IllegalArgumentException e) {
        return new ToolResult(false, "Invalid status: " + statusStr);
      }
    };
  }
}
