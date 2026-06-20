package io.codepilot.core.session.tool;

import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.list — list directory contents (similar to ls). */
@Component
public class FileListTool {
  private static final Logger log = LoggerFactory.getLogger(FileListTool.class);
  public static final String NAME = "fs.list";

  /** Directories to always skip when listing recursively. */
  private static final Set<String> SKIP_DIRS =
      Set.of(
          ".codepilot", ".git", ".svn", ".hg", "node_modules", ".idea", ".vs",
          "__pycache__", ".gradle", ".mvn", "target", "build", "dist", ".next", ".nuxt");

  /** Maximum number of entries in the result to prevent context bloat. */
  private static final int MAX_ENTRIES = 200;

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "List files and directories in a given directory path.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "path", Map.of("type", "string", "description", "Directory path to list."),
                    "recursive",
                        Map.of(
                            "type",
                            "boolean",
                            "description",
                            "Whether to list recursively (default false).")),
            "required", List.of("path")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> {
      String pathStr = (String) call.args().get("path");
      Boolean recursive = (Boolean) call.args().getOrDefault("recursive", false);
      if (pathStr == null) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Missing required parameter: path");
      }
      try {
        File dir = new File(pathStr);
        if (!dir.exists())
          return new io.codepilot.core.agent.tool.ToolResult(
              false, "Directory not found: " + pathStr);
        if (!dir.isDirectory())
          return new io.codepilot.core.agent.tool.ToolResult(false, "Not a directory: " + pathStr);

        StringBuilder sb = new StringBuilder();
        if (recursive) {
          listRecursive(dir.toPath(), sb);
        } else {
          File[] files = dir.listFiles();
          if (files == null)
            return new io.codepilot.core.agent.tool.ToolResult(false, "Could not list: " + pathStr);
          java.util.Arrays.sort(files, Comparator.comparing(File::getName));
          int count = 0;
          for (File f : files) {
            if (SKIP_DIRS.contains(f.getName())) continue;
            sb.append(f.isDirectory() ? "[DIR]  " : "[FILE] ").append(f.getName()).append("\n");
            count++;
            if (count >= MAX_ENTRIES) {
              sb.append("... (too many entries, showing first ")
                  .append(MAX_ENTRIES)
                  .append(")\n");
              break;
            }
          }
        }
        return new io.codepilot.core.agent.tool.ToolResult(true, sb.toString().trim());
      } catch (SecurityException e) {
        return new io.codepilot.core.agent.tool.ToolResult(false, "Permission denied: " + pathStr);
      } catch (Exception e) {
        log.error("File list failed", e);
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "File list error: " + e.getMessage());
      }
    };
  }

  private void listRecursive(Path dir, StringBuilder sb) throws IOException {
    int[] count = {0};
    Files.walkFileTree(
        dir,
        new SimpleFileVisitor<>() {
          @Override
          public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes attrs) {
            // Skip hidden/internal directories
            if (d != dir && SKIP_DIRS.contains(d.getFileName().toString())) {
              return FileVisitResult.SKIP_SUBTREE;
            }
            if (d != dir) {
              sb.append("[DIR]  ").append(dir.relativize(d)).append("\n");
              count[0]++;
              if (count[0] >= MAX_ENTRIES) {
                sb.append("... (too many entries, showing first ")
                    .append(MAX_ENTRIES)
                    .append(")\n");
                return FileVisitResult.TERMINATE;
              }
            }
            return FileVisitResult.CONTINUE;
          }

          @Override
          public FileVisitResult visitFile(Path f, BasicFileAttributes attrs) {
            sb.append("[FILE] ").append(dir.relativize(f)).append("\n");
            count[0]++;
            if (count[0] >= MAX_ENTRIES) {
              sb.append("... (too many entries, showing first ")
                  .append(MAX_ENTRIES)
                  .append(")\n");
              return FileVisitResult.TERMINATE;
            }
            return FileVisitResult.CONTINUE;
          }

          @Override
          public FileVisitResult visitFileFailed(Path f, IOException exc) {
            return FileVisitResult.SKIP_SUBTREE;
          }
        });
  }
}
