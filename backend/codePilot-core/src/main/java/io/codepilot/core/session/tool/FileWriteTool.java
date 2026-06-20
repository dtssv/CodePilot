package io.codepilot.core.session.tool;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.write — writes content to a file. */
@Component
public class FileWriteTool {

  public static final String NAME = "fs.write";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Write content to a file. Creates the file if it does not exist, overwrites if it does.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "path", Map.of("type", "string", "description", "Absolute path to the file."),
                    "content", Map.of("type", "string", "description", "Content to write.")),
            "required", List.of("path", "content")),
        false,
        true);
  }

  public ToolExecutor executor() {
    return call -> {
      String path = (String) call.args().get("path");
      String content = (String) call.args().get("content");
      if (path == null || content == null) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Missing required parameters: path, content");
      }
      try {
        File file = new File(path);
        File parent = file.getParentFile();
        if (parent != null && !parent.exists()) {
          Files.createDirectories(parent.toPath());
        }
        Files.writeString(file.toPath(), content, StandardCharsets.UTF_8);
        return new io.codepilot.core.agent.tool.ToolResult(true, "File written: " + path);
      } catch (IOException e) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Error writing file: " + e.getMessage());
      } catch (SecurityException e) {
        return new io.codepilot.core.agent.tool.ToolResult(false, "Permission denied: " + path);
      }
    };
  }
}
