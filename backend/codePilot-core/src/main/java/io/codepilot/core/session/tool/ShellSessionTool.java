package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: shell.session — manage interactive shell sessions. */
@Component
public class ShellSessionTool {
  public static final String NAME = "shell.session";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Manage interactive shell sessions. Supports 'exec' (run command in a persistent session), "
            + "'getOutput' (retrieve recent output), and 'close' (close a session).",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "action", Map.of("type", "string", "description", "Action: 'exec', 'getOutput', or 'close'."),
                "command", Map.of("type", "string", "description", "Command to execute (for exec action)."),
                "sessionId", Map.of("type", "string", "description", "Session ID for getOutput/close actions."),
                "cwd", Map.of("type", "string", "description", "Working directory for the command."),
                "timeoutMs", Map.of("type", "integer", "description", "Command timeout in ms (default 60000).")),
            "required", List.of("action")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
