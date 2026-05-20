package io.codepilot.core.graph;

import io.codepilot.core.dto.Patch;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Builds user-facing file-change summaries from patch DTOs (single source of truth). */
public final class GraphPatchUiHelper {

  private GraphPatchUiHelper() {}

  public static List<Map<String, Object>> buildWritingFiles(List<Patch> validPatches) {
    List<Map<String, Object>> writingFiles = new ArrayList<>();
    for (Patch p : validPatches) {
      for (Patch.Edit edit : p.patches()) {
        Map<String, Object> filePreview = new HashMap<>();
        filePreview.put("path", edit.path());
        filePreview.put("op", edit.op() != null ? edit.op().name().toLowerCase() : "write");
        if (edit.newContent() != null) {
          int lineCount = edit.newContent().split("\n").length;
          filePreview.put("lineCount", lineCount);
          String[] lines = edit.newContent().split("\n");
          String preview =
              String.join("\n", java.util.Arrays.copyOf(lines, Math.min(lines.length, 5)));
          if (lines.length > 5) {
            preview += "\n...";
          }
          filePreview.put("preview", preview);
        }
        writingFiles.add(filePreview);
      }
    }
    return writingFiles;
  }

  public static String buildWritingTextFromFiles(List<Map<String, Object>> files) {
    if (files.isEmpty()) {
      return "准备修改文件";
    }
    List<String> parts = new ArrayList<>();
    for (var f : files) {
      String path = String.valueOf(f.getOrDefault("path", "unknown"));
      String op = String.valueOf(f.getOrDefault("op", "write"));
      Object lineCount = f.get("lineCount");
      String label = "create".equals(op) ? "新建" : "delete".equals(op) ? "删除" : "修改";
      String part = label + ": " + path;
      if (lineCount != null) {
        part += " +" + lineCount + "行";
      }
      parts.add(part);
    }
    return String.join(", ", parts);
  }
}
