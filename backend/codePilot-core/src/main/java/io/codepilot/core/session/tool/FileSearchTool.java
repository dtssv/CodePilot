package io.codepilot.core.session.tool;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Built-in tool: fs.search — search for files by name pattern or content match. */
@Component
public class FileSearchTool {
  private static final Logger log = LoggerFactory.getLogger(FileSearchTool.class);
  public static final String NAME = "fs.search";

  private static final int MAX_RESULTS = 100;
  private static final long MAX_FILE_SIZE = 1_000_000; // 1 MB

  public ToolDefinition definition() {
    return new ToolDefinition(
        NAME,
        "Search for files by name pattern or regex content match.",
        Map.of(
            "type", "object",
            "properties",
                Map.of(
                    "path",
                        Map.of(
                            "type", "string", "description", "Directory to search in (recursive)."),
                    "pattern",
                        Map.of(
                            "type",
                            "string",
                            "description",
                            "Pattern to search for in file names or content."),
                    "regex",
                        Map.of(
                            "type",
                            "boolean",
                            "description",
                            "Whether pattern is a regex (default false)."),
                    "search_type",
                        Map.of(
                            "type",
                            "string",
                            "description",
                            "Either 'name' (default) to search file names, 'content' to search file"
                                + " contents (grep-like).")),
            "required", List.of("path", "pattern")),
        true,
        false);
  }

  public ToolExecutor executor() {
    return call -> {
      String pathStr = (String) call.args().get("path");
      String patternStr = (String) call.args().get("pattern");
      Boolean regex = (Boolean) call.args().getOrDefault("regex", false);
      String searchType = (String) call.args().getOrDefault("search_type", "name");

      if (pathStr == null || patternStr == null) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Missing required parameters: path, pattern");
      }

      try {
        File dir = new File(pathStr);
        if (!dir.exists() || !dir.isDirectory()) {
          return new io.codepilot.core.agent.tool.ToolResult(
              false, "Directory not found: " + pathStr);
        }

        Pattern pattern = regex ? Pattern.compile(patternStr, Pattern.CASE_INSENSITIVE) : null;
        StringBuilder sb = new StringBuilder();

        if ("content".equalsIgnoreCase(searchType)) {
          searchContent(dir.toPath(), pattern != null ? pattern.pattern() : patternStr, regex, sb);
        } else {
          searchNames(dir.toPath(), patternStr, regex, sb);
        }

        String result = sb.toString().trim();
        if (result.isEmpty())
          return new io.codepilot.core.agent.tool.ToolResult(true, "No matches found");
        return new io.codepilot.core.agent.tool.ToolResult(true, result);
      } catch (PatternSyntaxException e) {
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "Invalid regex pattern: " + e.getMessage());
      } catch (Exception e) {
        log.error("File search failed", e);
        return new io.codepilot.core.agent.tool.ToolResult(
            false, "File search error: " + e.getMessage());
      }
    };
  }

  private void searchNames(Path dir, String patternStr, boolean regex, StringBuilder sb)
      throws IOException {
    Pattern pattern = regex ? Pattern.compile(patternStr, Pattern.CASE_INSENSITIVE) : null;
    AtomicInteger count = new AtomicInteger(0);
    Files.walkFileTree(
        dir,
        new SimpleFileVisitor<>() {
          @Override
          public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
            if (count.get() >= MAX_RESULTS) return FileVisitResult.TERMINATE;
            String name = file.getFileName().toString();
            if (pattern != null
                ? pattern.matcher(name).find()
                : name.toLowerCase().contains(patternStr.toLowerCase())) {
              sb.append(file).append("\n");
              count.incrementAndGet();
            }
            return FileVisitResult.CONTINUE;
          }

          @Override
          public FileVisitResult visitFileFailed(Path f, IOException exc) {
            return FileVisitResult.SKIP_SUBTREE;
          }
        });
  }

  private void searchContent(Path dir, String patternStr, boolean regex, StringBuilder sb)
      throws IOException {
    AtomicInteger count = new AtomicInteger(0);
    Files.walkFileTree(
        dir,
        new SimpleFileVisitor<>() {
          @Override
          public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
            if (count.get() >= MAX_RESULTS) return FileVisitResult.TERMINATE;
            try {
              long size = attrs.size();
              if (size > MAX_FILE_SIZE) return FileVisitResult.CONTINUE; // skip large files
              String content = Files.readString(file, StandardCharsets.UTF_8);
              boolean match;
              if (regex) {
                match = Pattern.compile(patternStr).matcher(content).find();
              } else {
                match = content.contains(patternStr);
              }
              if (match) {
                sb.append(file).append("\n");
                count.incrementAndGet();
              }
            } catch (Exception ignored) {
              // skip unreadable files
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
