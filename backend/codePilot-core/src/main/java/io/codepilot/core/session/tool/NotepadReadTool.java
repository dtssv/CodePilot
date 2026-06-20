package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: notepad.read — read content from a persistent notepad/buffer. */
@Component
public class NotepadReadTool {
  public static final String NAME = "notepad.read";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Read content from a named notepad buffer that was previously written. "
            + "Notepads persist across turns within a session.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "name", Map.of("type", "string", "description", "Name/key of the notepad buffer to read.")),
            "required", List.of("name")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
