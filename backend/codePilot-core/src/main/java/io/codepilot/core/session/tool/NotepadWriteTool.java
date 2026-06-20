package io.codepilot.core.session.tool;

import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: notepad.write — write content to a persistent notepad/buffer. */
@Component
public class NotepadWriteTool {
  public static final String NAME = "notepad.write";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Write content to a named notepad buffer. Notepads persist across turns within a session "
            + "and can be read back later.",
        Map.of(
            "type", "object",
            "properties", Map.of(
                "name", Map.of("type", "string", "description", "Name/key for the notepad buffer."),
                "content", Map.of("type", "string", "description", "Content to write to the notepad."),
                "append", Map.of("type", "boolean", "description", "Whether to append to existing content (default false).")),
            "required", List.of("name", "content")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> new io.codepilot.core.agent.tool.ToolResult(
        true, "[REMOTE] Executed by plugin");
  }
}
