package io.codepilot.core.session.tool;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.read — reads a file's contents. */
@Component
public class FileReadTool {

  public static final String NAME = "fs.read";

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Read the contents of a file at the specified path.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "path",
                    Map.of(
                        "type", "string",
                        "description", "Absolute path to the file to read.")),
            "required", List.of("path")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> {
      String path = (String) call.args().get("path");
      if (path == null) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Missing required parameter: path");
      }
      try {
        File file = new File(path);
        if (!file.exists()) {
          return new io.codepilot.core.agent.tool.ToolResult(false, "File not found: " + path);
        }
        if (!file.isFile()) {
          return new io.codepilot.core.agent.tool.ToolResult(false, "Not a file: " + path);
        }
        String content = Files.readString(file.toPath(), StandardCharsets.UTF_8);
        return new io.codepilot.core.agent.tool.ToolResult(true, content);
      } catch (IOException e) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Error reading file: " + e.getMessage());
      } catch (SecurityException e) {
        return new io.codepilot.core.agent.tool.ToolResult(false, "Permission denied: " + path);
      }
    };
  }
}
