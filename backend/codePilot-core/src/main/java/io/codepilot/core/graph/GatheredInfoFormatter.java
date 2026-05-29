package io.codepilot.core.graph;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Formats {@code gatheredInfo} entries for LLM context (generate / reenter). */
public final class GatheredInfoFormatter {

  private GatheredInfoFormatter() {}

  /**
   * Format gathered info within a character budget. Newer entries (later in the map) are
   * preferred when the full payload does not fit.
   */
  @SuppressWarnings("unchecked")
  public static String formatWithinBudget(Map<String, Object> gatheredInfo, int maxChars) {
    if (gatheredInfo == null || gatheredInfo.isEmpty()) {
      return "";
    }
    if (maxChars <= 0) {
      return format(gatheredInfo);
    }
    String full = format(gatheredInfo);
    if (full.length() <= maxChars) {
      return full;
    }

    List<Map.Entry<String, Object>> entries = new ArrayList<>(gatheredInfo.entrySet());
    Collections.reverse(entries);
    Map<String, Object> subset = new LinkedHashMap<>();
    for (var entry : entries) {
      subset.put(entry.getKey(), entry.getValue());
      if (format(subset).length() > maxChars) {
        subset.remove(entry.getKey());
        break;
      }
    }

    if (subset.isEmpty()) {
      return truncate(full, maxChars);
    }

    String partial = format(subset);
    if (subset.size() < gatheredInfo.size()) {
      partial +=
          "\n... ("
              + (gatheredInfo.size() - subset.size())
              + " older gathered entries omitted for prompt budget)\n";
    }
    return partial;
  }

  @SuppressWarnings("unchecked")
  public static String format(Map<String, Object> gatheredInfo) {
    if (gatheredInfo == null || gatheredInfo.isEmpty()) {
      return "";
    }
    StringBuilder sb = new StringBuilder();
    for (var entry : gatheredInfo.entrySet()) {
      Object value = entry.getValue();
      if (!(value instanceof Map<?, ?> rawMap)) {
        sb.append("- ").append(entry.getKey()).append(": ").append(value).append("\n");
        continue;
      }
      Map<String, Object> map = (Map<String, Object>) rawMap;
      String kind = String.valueOf(map.getOrDefault("kind", "unknown"));
      String id = String.valueOf(map.getOrDefault("id", entry.getKey()));

      if (!entrySucceeded(map)) {
        appendFailure(sb, kind, id, map);
        continue;
      }

      Object result = map.get("result");
      if ("shell.exec".equals(kind) && result instanceof Map<?, ?> shell) {
        appendShellSuccess(sb, (Map<String, Object>) shell);
        continue;
      }

      if (result instanceof Map<?, ?> rawResultMap) {
        appendStructuredResult(sb, kind, (Map<String, Object>) rawResultMap);
      } else if (result != null) {
        sb.append("- ").append(kind).append(" (").append(id).append("): ").append(result).append("\n");
      } else {
        sb.append("- ").append(kind).append(" (").append(id).append("): ok\n");
      }
    }
    return sb.toString();
  }

  /** Only failed gathered entries — for repair / failure context. */
  @SuppressWarnings("unchecked")
  public static String formatFailures(Map<String, Object> gatheredInfo) {
    if (gatheredInfo == null || gatheredInfo.isEmpty()) {
      return "";
    }
    StringBuilder sb = new StringBuilder();
    sb.append("[FAILED TOOL / BUILD OUTPUT]\n");
    for (var entry : gatheredInfo.entrySet()) {
      Object value = entry.getValue();
      if (!(value instanceof Map<?, ?> rawMap)) {
        continue;
      }
      Map<String, Object> map = (Map<String, Object>) rawMap;
      if (entrySucceeded(map)) {
        continue;
      }
      String kind = String.valueOf(map.getOrDefault("kind", "unknown"));
      String id = String.valueOf(map.getOrDefault("id", entry.getKey()));
      appendFailure(sb, kind, id, map);
    }
    return sb.toString().trim();
  }

  @SuppressWarnings("unchecked")
  public static boolean entrySucceeded(Map<String, Object> map) {
    if (map.containsKey("ok")) {
      return Boolean.TRUE.equals(map.get("ok"));
    }
    if (map.containsKey("error")) {
      return false;
    }
    Object result = map.get("result");
    if ("shell.exec".equals(String.valueOf(map.get("kind"))) && result instanceof Map<?, ?>) {
      // Engineering layer does not infer: shell.exec with a result is considered
      // succeeded at the execution level. The model interprets exitCode/timedOut.
      return true;
    }
    return result != null;
  }

  private static void appendFailure(
      StringBuilder sb, String kind, String id, Map<String, Object> map) {
    String msg =
        stringOr(
            map.get("errorMessage"),
            map.get("error"),
            map.get("errorCode"),
            "unknown error");
    sb.append("- [FAILED] ").append(kind).append(" (").append(id).append("): ").append(msg).append("\n");
    Object result = map.get("result");
    if ("shell.exec".equals(kind) && result instanceof Map<?, ?> shellMap) {
      Map<String, Object> typedShell = stringifyMap(shellMap);
      appendShellOutput(sb, typedShell, true);
    }
  }

  private static void appendShellSuccess(StringBuilder sb, Map<String, Object> shell) {
    sb.append("- [OK] shell.exec");
    appendShellOutput(sb, shell, false);
  }

  private static void appendShellOutput(
      StringBuilder sb, Map<String, Object> shell, boolean failed) {
    Object cmd = shell.get("command");
    if (cmd != null && !cmd.toString().isBlank()) {
      sb.append(" command: `").append(cmd).append('`');
    }
    Object exit = shell.get("exitCode");
    if (exit != null) {
      sb.append(" exitCode=").append(exit);
    }
    Object cwd = shell.get("cwd");
    if (cwd != null && !cwd.toString().isBlank()) {
      sb.append(" cwd=").append(cwd);
    }
    sb.append('\n');
    String stderr = stringOr(shell.get("stderr"), "");
    String stdout = stringOr(shell.get("stdout"), "");
    if (!stderr.isBlank()) {
      sb.append("  stderr:\n```\n").append(truncate(stderr, 2000)).append("\n```\n");
    }
    if (!stdout.isBlank()) {
      sb.append("  stdout:\n```\n").append(truncate(stdout, failed ? 2000 : 1200)).append("\n```\n");
    }
  }

  private static void appendStructuredResult(
      StringBuilder sb, String kind, Map<String, Object> resultMap) {
    String path = String.valueOf(resultMap.getOrDefault("path", ""));
    Object content = resultMap.get("content");
    if (content != null && !content.toString().isBlank()) {
      String contentStr = content.toString();
      if (contentStr.length() > 4000) {
        contentStr = contentStr.substring(0, 4000) + "\n... (truncated)";
      }
      sb.append("- File: ").append(path).append("\n```\n").append(contentStr).append("\n```\n");
      return;
    }
    Object entries = resultMap.get("entries");
    if (entries != null) {
      int n = entries instanceof java.util.List<?> list ? list.size() : -1;
      sb.append("- Directory listing");
      if (!path.isBlank() && !"null".equals(path)) {
        sb.append(": ").append(path);
      }
      if (n >= 0) {
        sb.append(" (").append(n).append(" entries)");
        if (n == 0) {
          sb.append(" — empty; try another path or recursive list");
        }
      }
      sb.append("\n").append(entries).append("\n");
      return;
    }
    sb.append("- ").append(kind).append(": ").append(resultMap).append("\n");
  }

  private static String stringOr(Object primary, Object fallback) {
    if (primary != null && !primary.toString().isBlank()) {
      return primary.toString().trim();
    }
    if (fallback != null && !fallback.toString().isBlank()) {
      return fallback.toString().trim();
    }
    return "";
  }

  private static String stringOr(Object a, Object b, Object c, String def) {
    String s = stringOr(a, b);
    if (!s.isEmpty()) {
      return s;
    }
    s = stringOr(c, "");
    return s.isEmpty() ? def : s;
  }

  private static String truncate(String text, int max) {
    if (text.length() <= max) {
      return text;
    }
    return text.substring(0, max) + "\n... (truncated)";
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> stringifyMap(Map<?, ?> map) {
    return (Map<String, Object>) map;
  }
}
